# P8 raw evidence — S1b: a PASS must not race a sibling's NEEDS_FIXES

**Round:** 771 · **Phase 8 (live smoke)** · **Date:** 2026-08-05
**Scratch projects:** `0ecb3bd5-d15a-434d-b57a-f5e6d7c48d79` (`p8-s1b-pass-race-smoke`, run 1)
and `956b7261-6e6b-48f7-af1c-719f582a7b25` (`p8-s1b-pass-race-smoke-2`, run 2 — the one that
carries B1–B4; see §3.2 for why a second run was necessary)
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

| # | Assertion | Verdict | Source |
|---|-----------|---------|--------|
| B1 | No task row with round ≥ 2 exists while the PASS is outstanding — the PASS created nothing | **PASS** | §4.2, 66 samples |
| B2 | CHARLIE's task row is still `running` — deferred to its round, not settled individually | **PASS** | §4.2, 66 samples |
| B3 | Project status is still `active` — the PASS did not close round or project | **PASS** | §4.2, 66 samples |
| B4 | No new `runs` row appeared for this project during the window | **PASS** | §4.2, count pinned at 3 |
| B5 | Exactly ONE fix chain: one (round 2, builder, `Fix cycle 1`) + one (round 3, reviewer, `Re-review after fix cycle 1`) | **PASS** | §3.3 and §4.3 |
| B6 | `chain_key` values are literally `fix:1:1` and `rereview:1:1` | **PASS** | §3.3 and §4.3 |
| B7 | Merged brief contains `DELTA-FEEDBACK-7D4` | **PASS** | §3.3 and §4.3 |
| B8 | Merged brief does NOT contain `CHARLIE-APPROVAL-7C3` (PASS siblings omitted by design) | **PASS** — intent, not deviation | §3.3 and §4.3 |
| B9 | Duplicate-check query returns ZERO rows | **PASS** | §3.3 and §4.3 |

**Nine of nine PASS. No phase-blocking finding. No divergence between the unit tests and the
deployed engine.**

**The headline number:** the deployed engine held a settled `VERDICT: PASS` for **334 seconds
— about 33 manager ticks — and did nothing with it** while its dissenting sibling was still
running. Then, in a single tick, it produced exactly one fix chain carrying only the dissent.

**Two things a reader must not skim past.**

1. **This experiment was run twice, and the first run is reported in full even though it fell
   short.** Run 1 (§3) consolidated correctly but its PASS window was 9 seconds — the reviewer
   agent skipped the `sleep 150` in its brief — which is two samples where the brief demands
   four. Run 2 (§4) repeated the identical experiment with a delay the agent could not
   shortcut and produced a 334-second window. B1–B4 are sourced from run 2; B5–B9 hold in both.
2. **The reverse ordering was not tested.** This drives PASS-first-then-NEEDS_FIXES only. See
   §6 for exactly what is and is not proven.

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

## 4. Run 2 — the wide-window observation (this is the one that settles B1–B4)

Identical experiment, second scratch project, one fixture change: DELTA's delay is an explicit
tick loop it is told, in capitals, not to shorten — `for i in $(seq 1 40); do echo tick $i;
sleep 5; done`, re-run until 200 s of wall clock have passed. It complied, and then some.

**`SCRATCH2_RUN2 = 956b7261-6e6b-48f7-af1c-719f582a7b25`** (`p8-s1b-pass-race-smoke-2`)

```console
$ date -Is
2026-08-05T23:33:41+02:00
$ curl -sS -X POST http://127.0.0.1:7700/api/projects -H 'content-type: application/json' -d '{"name":"p8-s1b-pass-race-smoke-2","repo":"scratch","architect_tier":"fast","brief":"SYNTHETIC ENGINE SMOKE (run 2). ..."}'
{"project":{"id":"956b7261-6e6b-48f7-af1c-719f582a7b25","name":"p8-s1b-pass-race-smoke-2",...,"status":"active",...},"architectTask":{"id":"53904c6d-4e79-4ae3-a82c-ef3dde3e02d2","round":0,"role":"architect","title":"Plan: p8-s1b-pass-race-smoke-2","status":"pending",...}}

$ date -Is
2026-08-05T23:33:53+02:00
$ curl ... /tasks -d '{"role":"reviewer","round":1,"tier":"fast","title":"Sibling reviewer CHARLIE", ...}'
{"task":{"id":"3e630cee-da95-42e1-8c02-30ddf256101d","round":1,"role":"reviewer","title":"Sibling reviewer CHARLIE","status":"pending","run_id":null,"fix_cycle":0,"chain_key":null,...}}
$ curl ... /tasks -d '{"role":"reviewer","round":1,"tier":"fast","title":"Sibling reviewer DELTA", ...}'
{"task":{"id":"f6f36682-669a-4310-9e69-94f542278f5f","round":1,"role":"reviewer","title":"Sibling reviewer DELTA","status":"pending","run_id":null,"fix_cycle":0,"chain_key":null,...}}
```

### 4.1 The PASS was real and it was on disk

CHARLIE's final assistant message, read out of `runs.thread` for run
`41584459-12ea-4428-910a-8e97f65e0b44`:

```console
$ psql "$PGURL" -tAc "SELECT e->>'content' FROM runs r, jsonb_array_elements(r.thread) e WHERE r.id='41584459-12ea-4428-910a-8e97f65e0b44' AND e->>'role'='assistant' ORDER BY e->>'ts' DESC LIMIT 1"
CHARLIE-APPROVAL-7C3: Nothing here blocks. The worktree contains only the git directory and PLAN.md as expected. 

VERDICT: PASS
```

So there is no ambiguity about what the engine was holding: a settled, `completed` run whose
last verdict declaration is `VERDICT: PASS`, sitting in the database for the entire window
below.

### 4.2 The window — 5 min 34 s, 66 consecutive samples

```console
$ psql "$PGURL" -c "SELECT pt.title, r.status, r.started_at, r.completed_at FROM project_tasks pt JOIN runs r ON r.id=pt.run_id WHERE pt.project_id='$SCRATCH2_RUN2' ORDER BY r.created_at"
             title              |  status   |          started_at           |         completed_at          
--------------------------------+-----------+-------------------------------+-------------------------------
 Plan: p8-s1b-pass-race-smoke-2 | completed | 2026-08-05 21:33:46.740729+00 | 2026-08-05 21:34:05.375393+00
 Sibling reviewer CHARLIE       | completed | 2026-08-05 21:34:16.779227+00 | 2026-08-05 21:34:28.252795+00
 Sibling reviewer DELTA         | completed | 2026-08-05 21:34:16.783056+00 | 2026-08-05 21:40:02.417312+00
 Fix cycle 1                    | completed | 2026-08-05 21:40:17.294629+00 | 2026-08-05 21:40:45.39117+00
 Re-review after fix cycle 1    | running   | 2026-08-05 21:40:57.861914+00 | 
(5 rows)
```

CHARLIE settled `21:34:28.253` UTC; DELTA settled `21:40:02.417` UTC. **Window = 334.16
seconds ≈ 33 manager ticks** at the documented 10-second cadence. Both reviewers were claimed
in the same tick (`21:34:16.78`), so this is genuinely one round with one PASS outstanding, not
two rounds in sequence.

Sample count inside the window:

```console
$ grep -c "CHARLIE       | running     | completed" /tmp/s1b/poll2.log
66
```

66 samples — the brief asks for at least four. Six of them, spread across the window, verbatim:

```console
=== SAMPLE 2026-08-05T23:34:31+02:00 ===
{"status":"active","tasks":[{"round":0,"role":"architect","title":"Plan: p8-s1b-pass-race-smoke-2","status":"done","run_id":"7d463dd0-a845-4c0e-b586-dc91c61e3765"},{"round":1,"role":"reviewer","title":"Sibling reviewer CHARLIE","status":"running","run_id":"41584459-12ea-4428-910a-8e97f65e0b44"},{"round":1,"role":"reviewer","title":"Sibling reviewer DELTA","status":"running","run_id":"1e863678-1af8-43c0-af16-ab70647b2822"}]}
 round |             title              | task_status | run_status | chain_key 
-------+--------------------------------+-------------+------------+-----------
     0 | Plan: p8-s1b-pass-race-smoke-2 | done        | completed  | 
     1 | Sibling reviewer CHARLIE       | running     | completed  | 
     1 | Sibling reviewer DELTA         | running     | running    | 
(3 rows)

 runs_for_project 
------------------
                3
(1 row)

=== SAMPLE 2026-08-05T23:35:07+02:00 ===
{"status":"active","tasks":[{"round":0,"role":"architect","title":"Plan: p8-s1b-pass-race-smoke-2","status":"done","run_id":"7d463dd0-a845-4c0e-b586-dc91c61e3765"},{"round":1,"role":"reviewer","title":"Sibling reviewer CHARLIE","status":"running","run_id":"41584459-12ea-4428-910a-8e97f65e0b44"},{"round":1,"role":"reviewer","title":"Sibling reviewer DELTA","status":"running","run_id":"1e863678-1af8-43c0-af16-ab70647b2822"}]}
 round |             title              | task_status | run_status | chain_key 
-------+--------------------------------+-------------+------------+-----------
     0 | Plan: p8-s1b-pass-race-smoke-2 | done        | completed  | 
     1 | Sibling reviewer CHARLIE       | running     | completed  | 
     1 | Sibling reviewer DELTA         | running     | running    | 
(3 rows)

 runs_for_project 
------------------
                3
(1 row)

=== SAMPLE 2026-08-05T23:36:03+02:00 ===
{"status":"active","tasks":[{"round":0,"role":"architect","title":"Plan: p8-s1b-pass-race-smoke-2","status":"done","run_id":"7d463dd0-a845-4c0e-b586-dc91c61e3765"},{"round":1,"role":"reviewer","title":"Sibling reviewer CHARLIE","status":"running","run_id":"41584459-12ea-4428-910a-8e97f65e0b44"},{"round":1,"role":"reviewer","title":"Sibling reviewer DELTA","status":"running","run_id":"1e863678-1af8-43c0-af16-ab70647b2822"}]}
 round |             title              | task_status | run_status | chain_key 
-------+--------------------------------+-------------+------------+-----------
     0 | Plan: p8-s1b-pass-race-smoke-2 | done        | completed  | 
     1 | Sibling reviewer CHARLIE       | running     | completed  | 
     1 | Sibling reviewer DELTA         | running     | running    | 
(3 rows)

 runs_for_project 
------------------
                3
(1 row)

=== SAMPLE 2026-08-05T23:37:50+02:00 ===
{"status":"active","tasks":[{"round":0,"role":"architect","title":"Plan: p8-s1b-pass-race-smoke-2","status":"done","run_id":"7d463dd0-a845-4c0e-b586-dc91c61e3765"},{"round":1,"role":"reviewer","title":"Sibling reviewer CHARLIE","status":"running","run_id":"41584459-12ea-4428-910a-8e97f65e0b44"},{"round":1,"role":"reviewer","title":"Sibling reviewer DELTA","status":"running","run_id":"1e863678-1af8-43c0-af16-ab70647b2822"}]}
 round |             title              | task_status | run_status | chain_key 
-------+--------------------------------+-------------+------------+-----------
     0 | Plan: p8-s1b-pass-race-smoke-2 | done        | completed  | 
     1 | Sibling reviewer CHARLIE       | running     | completed  | 
     1 | Sibling reviewer DELTA         | running     | running    | 
(3 rows)

 runs_for_project 
------------------
                3
(1 row)

=== SAMPLE 2026-08-05T23:39:23+02:00 ===
{"status":"active","tasks":[{"round":0,"role":"architect","title":"Plan: p8-s1b-pass-race-smoke-2","status":"done","run_id":"7d463dd0-a845-4c0e-b586-dc91c61e3765"},{"round":1,"role":"reviewer","title":"Sibling reviewer CHARLIE","status":"running","run_id":"41584459-12ea-4428-910a-8e97f65e0b44"},{"round":1,"role":"reviewer","title":"Sibling reviewer DELTA","status":"running","run_id":"1e863678-1af8-43c0-af16-ab70647b2822"}]}
 round |             title              | task_status | run_status | chain_key 
-------+--------------------------------+-------------+------------+-----------
     0 | Plan: p8-s1b-pass-race-smoke-2 | done        | completed  | 
     1 | Sibling reviewer CHARLIE       | running     | completed  | 
     1 | Sibling reviewer DELTA         | running     | running    | 
(3 rows)

 runs_for_project 
------------------
                3
(1 row)

=== SAMPLE 2026-08-05T23:39:58+02:00 ===
{"status":"active","tasks":[{"round":0,"role":"architect","title":"Plan: p8-s1b-pass-race-smoke-2","status":"done","run_id":"7d463dd0-a845-4c0e-b586-dc91c61e3765"},{"round":1,"role":"reviewer","title":"Sibling reviewer CHARLIE","status":"running","run_id":"41584459-12ea-4428-910a-8e97f65e0b44"},{"round":1,"role":"reviewer","title":"Sibling reviewer DELTA","status":"running","run_id":"1e863678-1af8-43c0-af16-ab70647b2822"}]}
 round |             title              | task_status | run_status | chain_key 
-------+--------------------------------+-------------+------------+-----------
     0 | Plan: p8-s1b-pass-race-smoke-2 | done        | completed  | 
     1 | Sibling reviewer CHARLIE       | running     | completed  | 
     1 | Sibling reviewer DELTA         | running     | running    | 
(3 rows)

 runs_for_project 
------------------
                3
(1 row)
```

**B1 — PASS.** Across all 66 in-window samples the task table holds exactly three rows, all at
round 0 or 1. No row with `round >= 2` ever appeared while the PASS was outstanding. The PASS
created nothing — no fix chain, no next-round promotion, no re-review.

**B2 — PASS.** `Sibling reviewer CHARLIE` reads `task_status = running` in every in-window
sample, while its `run_status` is `completed`. The engine did not settle the task individually
on the strength of its own PASS; it deferred the decision to the round. This is precisely the
behaviour that was missing on the first night, when a PASS was a bare `return`.

**B3 — PASS.** `"status":"active"` in the API payload of every in-window sample. The PASS
neither closed the round nor closed the project. `closeFinishedProjects()` did not fire.

**B4 — PASS.** The `runs` count joined through this project's tasks stayed at **3** for all 66
samples (architect + CHARLIE + DELTA). Full distribution over the whole poll log:

```console
$ grep -A2 "runs_for_project" /tmp/s1b/poll2.log | grep -E "^ +[0-9]+$" | sort | uniq -c
      3                 1
     71                 3
      8                 4
      2                 5
```

1 run before the reviewers were claimed, 3 for the round (71 samples, covering the window plus
the tail before consolidation), 4 once `Fix cycle 1` spawned, 5 once the re-review spawned.
No run appeared during the window.

### 4.3 Consolidation after DELTA settled — B5 to B9 (run 2)

```console
$ psql "$PGURL" -c "SELECT round, role, title, status, fix_cycle, chain_key FROM project_tasks WHERE project_id='$SCRATCH2_RUN2' ORDER BY round, created_at"
 round |   role    |             title              | status  | fix_cycle |  chain_key   
-------+-----------+--------------------------------+---------+-----------+--------------
     0 | architect | Plan: p8-s1b-pass-race-smoke-2 | done    |         0 | 
     1 | reviewer  | Sibling reviewer CHARLIE       | done    |         0 | 
     1 | reviewer  | Sibling reviewer DELTA         | done    |         0 | 
     2 | builder   | Fix cycle 1                    | done    |         1 | fix:1:1
     3 | reviewer  | Re-review after fix cycle 1    | running |         1 | rereview:1:1
(5 rows)
```

**B5 — PASS.** One `(round 2, builder, Fix cycle 1)`, one `(round 3, reviewer, Re-review after
fix cycle 1)`. One fix chain from a two-reviewer round, second confirmation.

**B6 — PASS.** `chain_key` is literally `fix:1:1` and `rereview:1:1`; `fix_cycle=1` on both.

```console
$ psql "$PGURL" -c "SELECT round, role, title, count(*) FROM project_tasks WHERE project_id='$SCRATCH2_RUN2' GROUP BY 1,2,3 HAVING count(*) > 1"
 round | role | title | count 
-------+------+-------+-------
(0 rows)
```

**B9 — PASS.** Zero duplicates.

```console
$ psql "$PGURL" -tAc "SELECT brief FROM project_tasks WHERE project_id='$SCRATCH2_RUN2' AND title='Fix cycle 1'"
Reviewer feedback from round 1 (fix cycle 1). Address EVERY point below; the re-review will check all of them against your new diff.

## Feedback from: Sibling reviewer DELTA
## Review Complete

**DELTA-FEEDBACK-7D4**

The synthetic engine smoke test has completed all required checks. The 200-second delay loop executed successfully, allowing sibling reviewers to reach their verdicts before this one concludes. The scratch project has no license file.

There are no code paths to review, no error handling to verify, and no security concerns to audit in this synthetic harness—it exists purely to test the goal engine's multi-reviewer coordination and verdict aggregation.

VERDICT: NEEDS_FIXES

$ psql "$PGURL" -tAc "SELECT brief FROM project_tasks WHERE project_id='$SCRATCH2_RUN2' AND title='Fix cycle 1'" | grep -c "CHARLIE-APPROVAL-7C3"
0
```

**B7 — PASS.** `DELTA-FEEDBACK-7D4` present, DELTA's text carried in full.

**B8 — PASS.** `CHARLIE-APPROVAL-7C3` absent, zero occurrences. The PASS sibling is omitted, as
`mergeFeedback()` documents. **This is intent, not a bug** — the fix builder is handed only the
work it must do, not a reviewer's congratulations.

---

## 5. Closing the scratch projects

```console
$ curl -sS -X POST http://127.0.0.1:7700/api/projects/0ecb3bd5-d15a-434d-b57a-f5e6d7c48d79/status -H 'content-type: application/json' -d '{"status":"done"}'
{"project":{"id":"0ecb3bd5-d15a-434d-b57a-f5e6d7c48d79","name":"p8-s1b-pass-race-smoke",...,"status":"done",...,"updated_at":"2026-08-05 21:33:17.192853+00"}}
$ date -Is
2026-08-05T23:33:17+02:00
```

```console
$ curl -sS -X POST http://127.0.0.1:7700/api/projects/956b7261-6e6b-48f7-af1c-719f582a7b25/status -H 'content-type: application/json' -d '{"status":"done"}'
{"project":{"id":"956b7261-6e6b-48f7-af1c-719f582a7b25","name":"p8-s1b-pass-race-smoke-2",...,"status":"done",...,"updated_at":"2026-08-05 21:40:58.563392+00"}}
$ date -Is
2026-08-05T23:40:58+02:00
```

**One run was still in flight at close time and was deliberately not killed:** run 2's
`Re-review after fix cycle 1` started at `21:40:57.862` UTC, one second before the status POST
landed at `21:40:58.563`. Its cost is one fast-tier reviewer on an empty scratch worktree. In
run 1 the `Fix cycle 1` builder had already completed (`21:32:55.771`) before the close at
`21:33:17`, and its re-review never started — the round-2 close gated promotion, which is
itself a small live confirmation of the blocked/inactive-project gate (bug 2).

---

## 6. What this proves, and what it does not

**Proves.** On the deployed engine, a reviewer PASS is inert until its whole round has settled.
For 5 minutes 34 seconds and roughly 33 manager ticks the engine sat on a `completed` run
carrying `VERDICT: PASS` and did nothing with it: no task marked done, no round closed, no
project closed, no run spawned, no round-2 row created. When the dissenting sibling finally
landed, one tick produced exactly one fix chain with the documented chain keys and a merged
brief containing the dissent and only the dissent. Twice, independently, on two scratch
projects.

**Does not prove.** This exercises the ordering PASS-first-then-NEEDS_FIXES. The reverse
ordering (NEEDS_FIXES settles first, PASS lands late) was not driven here; by the code's rule
order — unsettled sibling → wait, decided before any verdict is parsed — it is the same code
path, but this transcript does not contain that observation and should not be read as if it
did. Nor does it exercise three or more reviewers, an unparseable verdict inside a mixed round,
or a project transitioning to `blocked` mid-round.

**No divergence between the unit tests and the deployed engine was observed.** Every assertion
the pure-function tests make about `consolidateReviewerRound()` and `mergeFeedback()` — one
chain, `fix:<round>:<cycle>` / `rereview:<round>:<cycle>`, dissent merged, PASS omitted — is
what the live engine did with real runs and real timing.

### Hygiene during this task

- `/opt/forge-ai-os` was never edited. It was `git status --porcelain`-clean at the start and
  the only commands run against it were `git log` and `git status`.
- No `pm2 restart`, `pm2 stop`, or `pm2 delete` was issued. `pm2 jlist` and `pm2 env 35` (both
  read-only) were used once each, to locate the database URL.
- Every database statement in this transcript is a `SELECT`. No `INSERT`/`UPDATE`/`DELETE`/DDL.
- No task was created in the parent project `4120f785-fd86-414c-9a04-f10b2cd0c365`. The only
  things created were the two scratch projects and their four reviewer tasks.
- The only file written in this worktree is this one. `docs/plan/evidence/p8-raw-s1-s2.md`,
  owned by a sibling task in the same round, was not touched, and no `git checkout`, `git
  stash`, or `git reset` was run.

### One honest note on method

The brief specified a single scratch project. Run 1 produced a valid consolidation but only a
9-second PASS window — two samples where the brief asks for four — because the reviewer agent
silently skipped the `sleep 150` it was briefed to run. Rather than write up a two-sample
window as if it satisfied the requirement, I ran the identical experiment a second time with a
delay instruction the agent could not shortcut. Both runs are reported in full, including the
one that came up short. The scoreboard verdicts for B1–B4 are sourced from run 2; B5–B9 are
confirmed independently in both.
