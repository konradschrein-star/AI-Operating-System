# P8 raw evidence — S1 reviewer-round consolidation + S2 project-status gating, against the LIVE engine

**Round:** 771 · **Date:** 2026-08-05
**Scratch project id:** `75b2a54f-40b8-4f80-bcc5-698f2a62db3b`
**Branch:** `project/4120f785` · **Working dir:** `/opt/ai-os/workspace/projects/4120f785-fd86-414c-9a04-f10b2cd0c365`
**Engine under test:** deployed `/opt/forge-ai-os`, live `forge-executor` (NOT this worktree)
**node** v22.22.2 · worktree HEAD at start `818d0f0`

This file is evidence, not code. Every block is command → verbatim output → verdict. Nothing is
paraphrased, nothing is reconstructed from memory, every timestamp is real. Where something could
not be observed it says so instead of inventing a result.

`$PGURL` is the `DATABASE_URL` lifted from the live forge-control pm2 env. It is written as
`psql "$PGURL"` everywhere; the expanded URL (which carries a password) appears nowhere in this file.
Every database statement in this round was a `SELECT`. No writes were issued.

---

## Scoreboard — read this first

| # | Assertion | Verdict |
|---|-----------|---------|
| A1 | exactly ONE row (round=2, role=builder, title `Fix cycle 1`) | _pending_ |
| A2 | exactly ONE row (round=3, role=reviewer, title `Re-review after fix cycle 1`) | _pending_ |
| A3 | chain_keys are literally `fix:1:1` and `rereview:1:1` | _pending_ |
| A4 | `Fix cycle 1` brief contains BOTH `ALPHA-FEEDBACK-7A1` and `BRAVO-FEEDBACK-7B2` | _pending_ |
| A5 | duplicate-check query returns ZERO rows | _pending_ |
| A6 | O1 held — a settled reviewer triggered no action while its sibling was unsettled | _pending_ |
| A7 | re-review brief contains the merged feedback (both tokens) | _pending_ |
| S2a | while `paused`: nothing promotes, no new runs | _pending_ |
| S2b | pause does NOT kill the in-flight BRAVO run | _pending_ |
| S2c | on resume, round-2 work promotes within ~3 ticks | _pending_ |

---

## 0. Read-only DB access

```console
$ PMID=$(pm2 jlist | python3 -c "import json,sys;d=json.load(sys.stdin);print([p['pm_id'] for p in d if p['name']=='forge-control'][0])")
$ echo "pmid=$PMID"
pmid=35
$ PGURL=$(pm2 env $PMID | sed 's/\x1b\[[0-9;]*m//g' | awk -F': ' '/^DATABASE_URL/{print $2}')
$ psql "$PGURL" -tAc "select 1"
1
```

**Verdict: access established, read-only.**

---

## 1. STEP 1 — create the scratch project

```console
$ date -Is
2026-08-05T23:31:03+02:00
$ curl -sS -X POST http://127.0.0.1:7700/api/projects -H 'content-type: application/json' -d @/tmp/p8_proj.json
```

Response (verbatim, pretty-printed only by line wrapping):

```json
{"project":{"id":"75b2a54f-40b8-4f80-bcc5-698f2a62db3b","name":"p8-s1-s2-consolidation-smoke","brief":"SYNTHETIC ENGINE SMOKE. This project exists only so the goal engine executes its reviewer-consolidation path. You are the round-0 architect: create NO tasks, no planning corpus, no phases, no builders, no reviewers. Another agent creates every task in this project directly over the API. Write a one-paragraph PLAN.md saying exactly that, commit it, and STOP. Your final message is one sentence. Creating any task here corrupts the experiment.","repo":"scratch","workspace_dir":"/opt/ai-os/workspace/projects/75b2a54f-40b8-4f80-bcc5-698f2a62db3b","base_branch":"main","work_branch":"main","status":"active","metadata":{},"created_at":"2026-08-05 21:31:03.026256+00","updated_at":"2026-08-05 21:31:03.05704+00"},"architectTask":{"id":"93030c4b-98e4-449a-98a1-f512622068cb","project_id":"75b2a54f-40b8-4f80-bcc5-698f2a62db3b","round":0,"role":"architect","title":"Plan: p8-s1-s2-consolidation-smoke","brief":"SYNTHETIC ENGINE SMOKE. ...","status":"pending","run_id":null,"fix_cycle":0,"tier":"fast","attempt":0,"chain_key":null,"created_at":"2026-08-05 21:31:03.026256+00","updated_at":"2026-08-05 21:31:03.026256+00"}}
```

`SCRATCH1 = 75b2a54f-40b8-4f80-bcc5-698f2a62db3b`. Round-0 architect auto-seeded as documented.

---

## 2. STEP 2 — the two sibling reviewers at round 1

Both POSTs landed in the same wall-clock second as the project creation (`23:31:03`), well before
the architect settled — so `closeFinishedProjects()` never saw an empty task set.

```console
$ date -Is
2026-08-05T23:31:03+02:00
$ curl -sS -X POST http://127.0.0.1:7700/api/projects/$SCRATCH1/tasks -H 'content-type: application/json' -d @/tmp/p8_alpha.json
{"task":{"id":"be48bedc-f2a9-4927-a2e8-d95aeae149b8","project_id":"75b2a54f-40b8-4f80-bcc5-698f2a62db3b","round":1,"role":"reviewer","title":"Sibling reviewer ALPHA","brief":"SYNTHETIC ENGINE TEST — ... literal token ALPHA-FEEDBACK-7A1 ... VERDICT: NEEDS_FIXES","status":"pending","run_id":null,"fix_cycle":0,"tier":"fast","attempt":0,"chain_key":null,"created_at":"2026-08-05 21:31:03.120737+00","updated_at":"2026-08-05 21:31:03.120737+00"}}

$ date -Is
2026-08-05T23:31:03+02:00
$ curl -sS -X POST http://127.0.0.1:7700/api/projects/$SCRATCH1/tasks -H 'content-type: application/json' -d @/tmp/p8_bravo.json
{"task":{"id":"2f499331-119a-414d-afd4-e5292a599020","project_id":"75b2a54f-40b8-4f80-bcc5-698f2a62db3b","round":1,"role":"reviewer","title":"Sibling reviewer BRAVO","brief":"SYNTHETIC ENGINE TEST — ... run `sleep 120` ... literal token BRAVO-FEEDBACK-7B2 ... VERDICT: NEEDS_FIXES","status":"pending","run_id":null,"fix_cycle":0,"tier":"fast","attempt":0,"chain_key":null,"created_at":"2026-08-05 21:31:03.139994+00","updated_at":"2026-08-05 21:31:03.139994+00"}}
```

No 409 on either. Task ids: ALPHA `be48bedc-f2a9-4927-a2e8-d95aeae149b8`, BRAVO
`2f499331-119a-414d-afd4-e5292a599020`.

First observed engine state, 11 seconds later — the architect claimed, both reviewers held
`pending` behind the round gate:

```console
=== 2026-08-05T23:31:14+02:00
proj=active
0|architect|Plan: p8-s1-s2-consolidation-smoke|running|0|-|a8ba0bfb-a252-4277-85e1-06f152d440fb|running
1|reviewer|Sibling reviewer ALPHA|pending|0|-|-|-
1|reviewer|Sibling reviewer BRAVO|pending|0|-|-|-
```

**Verdict: setup as designed. Round 0 running, round 1 gated.**

<!-- SECTIONS 3+ APPENDED LIVE AS THE RUN PROGRESSES -->
