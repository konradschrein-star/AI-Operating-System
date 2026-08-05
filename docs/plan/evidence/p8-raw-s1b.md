# P8 raw evidence — S1b: a PASS must not race a sibling's NEEDS_FIXES

**Round:** 771 · **Phase 8 (live smoke)** · **Date:** 2026-08-05
**Scratch project:** `0ecb3bd5-d15a-434d-b57a-f5e6d7c48d79` (`p8-s1b-pass-race-smoke`)
**Branch:** `project/4120f785`
**Working dir for every command:** `/opt/ai-os/workspace/projects/4120f785-fd86-414c-9a04-f10b2cd0c365`
**Engine under test:** the DEPLOYED forge-control/forge-executor at `/opt/forge-ai-os`,
commit `76a6085 merge(p7): deploy transcript for round 715`, working tree clean.

This file is evidence, not code. It drives one mixed-verdict reviewer round through the live
engine and records what the engine actually did. Every block is command → verbatim output →
verdict. Nothing is paraphrased; nothing is reconstructed from memory. Where something could
not be observed, it says so instead of inventing it.

The database password is never written here. Every psql invocation is shown as
`psql "$PGURL"`, where `$PGURL` was read once from the running process's environment (§0).

---

## Scoreboard — read this first

| # | Assertion | Verdict |
|---|-----------|---------|
| B1 | No task row with round ≥ 2 exists while the PASS is outstanding — the PASS created nothing | _pending_ |
| B2 | CHARLIE's task row is still `running` — deferred to its round, not settled individually | _pending_ |
| B3 | Project status is still `active` — the PASS did not close round or project | _pending_ |
| B4 | No new `runs` row appeared for this project during the window | _pending_ |
| B5 | Exactly ONE fix chain: one (round 2, builder, `Fix cycle 1`) + one (round 3, reviewer, `Re-review after fix cycle 1`) | _pending_ |
| B6 | `chain_key` values are literally `fix:1:1` and `rereview:1:1` | _pending_ |
| B7 | Merged brief contains `DELTA-FEEDBACK-7D4` | _pending_ |
| B8 | Merged brief does NOT contain `CHARLIE-APPROVAL-7C3` (PASS siblings omitted by design) | _pending_ |
| B9 | Duplicate-check query returns ZERO rows | _pending_ |

---

## 0. Read-only DB access

```console
$ PMID=$(pm2 jlist | python3 -c "import json,sys;d=json.load(sys.stdin);print([p['pm_id'] for p in d if p['name']=='forge-control'][0])")
$ echo "PMID=$PMID"
PMID=35
$ PGURL=$(pm2 env $PMID | sed 's/\x1b\[[0-9;]*m//g' | awk -F': ' '/^DATABASE_URL/{print $2}')
$ psql "$PGURL" -tAc "select 1"
1
```

Verdict: **read-only access established.** Every statement issued in this transcript is a
`SELECT`. No `INSERT`/`UPDATE`/`DELETE`/DDL was run against the database at any point.

The deployed engine was confirmed unmodified before the experiment:

```console
$ cd /opt/forge-ai-os && git log --oneline -1 && git status --porcelain | head
76a6085 merge(p7): deploy transcript for round 715
```

`git status --porcelain` printed nothing — the live checkout is clean, and stayed untouched
for the whole run.

---

## 1. The scratch project

```console
$ date -Is
2026-08-05T23:30:57+02:00
$ curl -sS -X POST http://127.0.0.1:7700/api/projects -H 'content-type: application/json' -d '{"name":"p8-s1b-pass-race-smoke","repo":"scratch","architect_tier":"fast","brief":"SYNTHETIC ENGINE SMOKE. ..."}'
```

```json
{"project":{"id":"0ecb3bd5-d15a-434d-b57a-f5e6d7c48d79","name":"p8-s1b-pass-race-smoke","brief":"SYNTHETIC ENGINE SMOKE. This project exists only so the goal engine executes a mixed-verdict reviewer round. You are the round-0 architect: create NO tasks, no planning corpus, no phases, no builders, no reviewers. Another agent creates every task in this project directly over the API. Write a one-paragraph PLAN.md saying exactly that, commit it, and STOP. Your final message is one sentence. Creating any task here corrupts the experiment.","repo":"scratch","workspace_dir":"/opt/ai-os/workspace/projects/0ecb3bd5-d15a-434d-b57a-f5e6d7c48d79","base_branch":"main","work_branch":"main","status":"active","metadata":{},"created_at":"2026-08-05 21:30:57.644596+00","updated_at":"2026-08-05 21:30:57.689817+00"},"architectTask":{"id":"0fcf7a5a-d505-42e4-a1ea-1587612f63b6","project_id":"0ecb3bd5-d15a-434d-b57a-f5e6d7c48d79","round":0,"role":"architect","title":"Plan: p8-s1b-pass-race-smoke","brief":"SYNTHETIC ENGINE SMOKE. This project exists only so the goal engine executes a mixed-verdict reviewer round. You are the round-0 architect: create NO tasks, no planning corpus, no phases, no builders, no reviewers. Another agent creates every task in this project directly over the API. Write a one-paragraph PLAN.md saying exactly that, commit it, and STOP. Your final message is one sentence. Creating any task here corrupts the experiment.","status":"pending","run_id":null,"fix_cycle":0,"tier":"fast","attempt":0,"chain_key":null,"created_at":"2026-08-05 21:30:57.644596+00","updated_at":"2026-08-05 21:30:57.644596+00"}}
```

`SCRATCH2 = 0ecb3bd5-d15a-434d-b57a-f5e6d7c48d79`. Round 0 is the single auto-seeded
architect task, exactly as documented.

---

## 2. The two sibling reviewers at round 1

Both POSTs were issued 10 seconds after project creation, before the architect settled.

```console
$ date -Is
2026-08-05T23:31:07+02:00
$ curl -sS -X POST http://127.0.0.1:7700/api/projects/$SCRATCH2/tasks -H 'content-type: application/json' -d '{"role":"reviewer","round":1,"tier":"fast","title":"Sibling reviewer CHARLIE", ...}'
```

```json
{"task":{"id":"fa3cc168-e75b-410a-9ef6-38872b56cd65","project_id":"0ecb3bd5-d15a-434d-b57a-f5e6d7c48d79","round":1,"role":"reviewer","title":"Sibling reviewer CHARLIE","brief":"SYNTHETIC ENGINE TEST — there is no real code to review and no repository to check. Do EXACTLY this and nothing more: run `pwd`, run `ls -a`, then write your final message. It must contain the literal token CHARLIE-APPROVAL-7C3 and the sentence: Nothing here blocks. Do NOT create tasks. Do NOT call the forge-control API. Do NOT edit anything outside this worktree. Do NOT run pm2. End your final message with this exact line, and make it the LAST verdict declaration anywhere in your message:\nVERDICT: PASS","status":"pending","run_id":null,"fix_cycle":0,"tier":"fast","attempt":0,"chain_key":null,"created_at":"2026-08-05 21:31:07.14811+00","updated_at":"2026-08-05 21:31:07.14811+00"}}
```

```console
$ curl -sS -X POST http://127.0.0.1:7700/api/projects/$SCRATCH2/tasks -H 'content-type: application/json' -d '{"role":"reviewer","round":1,"tier":"fast","title":"Sibling reviewer DELTA", ...}'
```

```json
{"task":{"id":"11dba8ca-9e40-4f79-809e-cf70cb2de8ab","project_id":"0ecb3bd5-d15a-434d-b57a-f5e6d7c48d79","round":1,"role":"reviewer","title":"Sibling reviewer DELTA","brief":"SYNTHETIC ENGINE TEST — there is no real code to review and no repository to check. Do EXACTLY this and nothing more, in order: run `pwd`, run `ls -a`, run `sleep 150` (this delay is deliberate — the sibling reviewer must settle well before you do), then write your final message. It must contain the literal token DELTA-FEEDBACK-7D4 and the sentence: The scratch project has no license file. Do NOT create tasks. Do NOT call the forge-control API. Do NOT edit anything outside this worktree. Do NOT run pm2. End your final message with this exact line, and make it the LAST verdict declaration anywhere in your message:\nVERDICT: NEEDS_FIXES","status":"pending","run_id":null,"fix_cycle":0,"tier":"fast","attempt":0,"chain_key":null,"created_at":"2026-08-05 21:31:07.160664+00","updated_at":"2026-08-05 21:31:07.160664+00"}}
```

Neither POST returned 409. Both tasks landed `pending` at round 1, `fix_cycle=0`,
`chain_key=NULL`.

Verdict: **setup complete.** CHARLIE will declare `VERDICT: PASS` within seconds of being
claimed; DELTA sleeps 150s before declaring `VERDICT: NEEDS_FIXES`. The window between the two
is the experiment.

---

## 3. Run 1 — consolidation observed, but the PASS window was too short

Run 1 executed end to end and produced a textbook consolidation. What it did **not** produce
was the four-sample window the brief demands: DELTA ignored its `sleep 150` and settled
9 seconds after CHARLIE, so the engine only had one manager tick in which it could have
misbehaved. That is honest but thin evidence for B1–B4, so §4 re-runs the whole experiment
with a delay the agent cannot shortcut. B5–B9 below are from run 1 and stand on their own.

### 3.1 The state transitions, sampled every 5 s

Extracted from the poll log (`{status, tasks[]}` from the API plus the joined task/run query,
both issued every 5 seconds).

```console
=== SAMPLE 2026-08-05T23:31:47+02:00 ===
     1 | Sibling reviewer CHARLIE     | running     | running    | 
     1 | Sibling reviewer DELTA       | running     | running    | 

=== SAMPLE 2026-08-05T23:31:57+02:00 ===
{"status":"active","tasks":[{"round":0,"role":"architect","title":"Plan: p8-s1b-pass-race-smoke","status":"done","run_id":"aa133f48-4e8c-4c6a-8a82-31e069580dcb"},{"round":1,"role":"reviewer","title":"Sibling reviewer CHARLIE","status":"running","run_id":"a9c2a748-2d27-4262-977a-5eaff395ba11"},{"round":1,"role":"reviewer","title":"Sibling reviewer DELTA","status":"running","run_id":"c5e07408-3a24-4331-8f8d-bdcb7b1e8dbc"}]}
 round |            title             | task_status | run_status | chain_key 
-------+------------------------------+-------------+------------+-----------
     0 | Plan: p8-s1b-pass-race-smoke | done        | completed  | 
     1 | Sibling reviewer CHARLIE     | running     | completed  | 
     1 | Sibling reviewer DELTA       | running     | running    | 
(3 rows)

=== SAMPLE 2026-08-05T23:32:02+02:00 ===
{"status":"active","tasks":[{"round":0,"role":"architect","title":"Plan: p8-s1b-pass-race-smoke","status":"done","run_id":"aa133f48-4e8c-4c6a-8a82-31e069580dcb"},{"round":1,"role":"reviewer","title":"Sibling reviewer CHARLIE","status":"running","run_id":"a9c2a748-2d27-4262-977a-5eaff395ba11"},{"round":1,"role":"reviewer","title":"Sibling reviewer DELTA","status":"running","run_id":"c5e07408-3a24-4331-8f8d-bdcb7b1e8dbc"}]}
 round |            title             | task_status | run_status | chain_key 
-------+------------------------------+-------------+------------+-----------
     0 | Plan: p8-s1b-pass-race-smoke | done        | completed  | 
     1 | Sibling reviewer CHARLIE     | running     | completed  | 
     1 | Sibling reviewer DELTA       | running     | running    | 
(3 rows)

=== SAMPLE 2026-08-05T23:32:07+02:00 ===
     1 | Sibling reviewer CHARLIE     | running     | completed  | 
     1 | Sibling reviewer DELTA       | running     | completed  | 

=== SAMPLE 2026-08-05T23:32:17+02:00 ===
     1 | Sibling reviewer CHARLIE     | done        | completed  | 
     1 | Sibling reviewer DELTA       | done        | completed  | 
     2 | Fix cycle 1                  | pending     |            | fix:1:1
     3 | Re-review after fix cycle 1  | pending     |            | rereview:1:1
```

Note the shape of it: **both reviewer task rows flip from `running` to `done` in the same
tick that creates the fix chain.** Neither was settled individually. CHARLIE's PASS sat on
disk as a `completed` run under a `running` task for the whole window.

### 3.2 Why run 1 is not sufficient for B1–B4

```console
$ psql "$PGURL" -c "SELECT pt.title, r.id, r.status, r.created_at, r.updated_at FROM project_tasks pt JOIN runs r ON r.id=pt.run_id WHERE pt.project_id='$SCRATCH2' ORDER BY r.created_at"
            title             |                  id                  |  status   |          created_at           |          updated_at           
------------------------------+--------------------------------------+-----------+-------------------------------+-------------------------------
 Plan: p8-s1b-pass-race-smoke | aa133f48-4e8c-4c6a-8a82-31e069580dcb | completed | 2026-08-05 21:31:04.4034+00   | 2026-08-05 21:31:26.873527+00
 Sibling reviewer CHARLIE     | a9c2a748-2d27-4262-977a-5eaff395ba11 | completed | 2026-08-05 21:31:44.67876+00  | 2026-08-05 21:31:56.499137+00
 Sibling reviewer DELTA       | c5e07408-3a24-4331-8f8d-bdcb7b1e8dbc | completed | 2026-08-05 21:31:44.683393+00 | 2026-08-05 21:32:05.608765+00
 Fix cycle 1                  | 4e3d4e52-de99-4ebb-9424-c7bd414aef7c | completed | 2026-08-05 21:32:24.916189+00 | 2026-08-05 21:32:55.771106+00
(4 rows)
```

CHARLIE finished at `21:31:56.499` UTC, DELTA at `21:32:05.609` UTC. **The window is 9.11
seconds** — roughly one 10-second manager tick, and only two poll samples. The brief asks for
at least four samples ~10 s apart. DELTA was briefed to `sleep 150`; it did not, and finished
its whole run in 21 seconds. That is an agent-compliance failure in my test fixture, not an
engine finding. Run 2 (§4) fixes the fixture.

### 3.3 Consolidation result — B5, B6, B7, B8, B9 (run 1)

```console
$ psql "$PGURL" -c "SELECT round, role, title, status, fix_cycle, chain_key FROM project_tasks WHERE project_id='$SCRATCH2' ORDER BY round, created_at"
 round |   role    |            title             | status  | fix_cycle |  chain_key   
-------+-----------+------------------------------+---------+-----------+--------------
     0 | architect | Plan: p8-s1b-pass-race-smoke | done    |         0 | 
     1 | reviewer  | Sibling reviewer CHARLIE     | done    |         0 | 
     1 | reviewer  | Sibling reviewer DELTA       | done    |         0 | 
     2 | builder   | Fix cycle 1                  | running |         1 | fix:1:1
     3 | reviewer  | Re-review after fix cycle 1  | pending |         1 | rereview:1:1
(5 rows)
```

**B5 — PASS.** Exactly one fix chain: one `(round 2, builder, Fix cycle 1)` and one
`(round 3, reviewer, Re-review after fix cycle 1)`. Two NEEDS_FIXES-eligible reviewer rows in
round 1 produced ONE builder, not two. Five rows total, no strays.

**B6 — PASS.** `chain_key` is literally `fix:1:1` on the builder and `rereview:1:1` on the
re-reviewer, `fix_cycle=1` on both.

```console
$ psql "$PGURL" -c "SELECT round, role, title, count(*) FROM project_tasks WHERE project_id='$SCRATCH2' GROUP BY 1,2,3 HAVING count(*) > 1"
 round | role | title | count 
-------+------+-------+-------
(0 rows)
```

**B9 — PASS.** Zero duplicate `(round, role, title)` groups.

```console
$ psql "$PGURL" -tAc "SELECT brief FROM project_tasks WHERE project_id='$SCRATCH2' AND title='Fix cycle 1'"
Reviewer feedback from round 1 (fix cycle 1). Address EVERY point below; the re-review will check all of them against your new diff.

## Feedback from: Sibling reviewer DELTA
Final review message from DELTA:

The scratch project has no license file. DELTA-FEEDBACK-7D4 indicates the repository structure is minimal and lacks standard OSS licensing documentation, which would be a compliance gap in any production context. However, this is consistent with the synthetic test project specification.

VERDICT: NEEDS_FIXES
```

**B7 — PASS.** The merged brief carries `DELTA-FEEDBACK-7D4` and DELTA's full, untruncated
final text under a `## Feedback from: Sibling reviewer DELTA` heading.

```console
$ psql "$PGURL" -tAc "SELECT brief FROM project_tasks WHERE project_id='$SCRATCH2' AND title='Fix cycle 1'" | grep -c "CHARLIE-APPROVAL-7C3"
0
```

**B8 — PASS.** Zero occurrences of `CHARLIE-APPROVAL-7C3`. The PASS sibling is absent from the
merged brief, exactly as `mergeFeedback()` intends — there is no `## Feedback from: Sibling
reviewer CHARLIE` section at all. The deployed engine matches the documented intent; this is
not a deviation.

---

_(§4 — run 2, the wide-window observation — and §5 follow. This file is committed mid-run so
that a killed run still leaves its evidence on disk.)_
