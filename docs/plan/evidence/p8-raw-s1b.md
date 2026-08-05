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

_(Sections 3–5 and the scoreboard are filled in as the observation proceeds; this file is
committed mid-run so that a killed run still leaves its evidence on disk.)_
