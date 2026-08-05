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
| A1 | exactly ONE row (round=2, role=builder, title `Fix cycle 1`) | **PASS** |
| A2 | exactly ONE row (round=3, role=reviewer, title `Re-review after fix cycle 1`) | **PASS** |
| A3 | chain_keys are literally `fix:1:1` and `rereview:1:1` | **PASS** |
| A4 | `Fix cycle 1` brief contains BOTH `ALPHA-FEEDBACK-7A1` and `BRAVO-FEEDBACK-7B2` | **PASS** |
| A5 | duplicate-check query returns ZERO rows | **PASS** |
| A6 | O1 held — a settled reviewer triggered no action while its sibling was unsettled | **PASS** (window was 13.9 s, not the ~2 min the brief assumed — see §4) |
| A7 | re-review brief contains the merged feedback (both tokens) | **PASS** |
| S2a | while `paused`: nothing promotes, no new runs | **PASS** |
| S2b | pause does NOT kill the in-flight run | **PASS** |
| S2c | on resume, work promotes within ~3 ticks | **PASS** (1 tick) |

**Zero divergence found between `project-reconcile.ts`'s unit-tested behaviour and the deployed
engine.** Chain keys, titles, fix_cycle numbering, feedback merging, the deferral of a settled
reviewer, and both status gates all behaved exactly as the 466 unit tests describe.

**Four things the reviewer must not skim past:**

1. **The N≥2 reviewer path works in production.** Two NEEDS_FIXES siblings produced exactly one
   `Fix cycle 1` builder and one `Re-review after fix cycle 1` reviewer, created in a *single*
   transaction (identical `created_at` to the microsecond, §5), with both reviewers' feedback
   merged into both briefs. No duplicate chain, no race.
2. **The O1 deferral window was 13.9 s, not ~2 minutes.** BRAVO was briefed to `sleep 120` and did
   not do so — its whole run lasted 25.2 s. The window was therefore too short to sample three
   times at 10 s spacing as the brief instructed. §4 says so plainly and proves O1 from durable
   database timestamps instead, which is stronger evidence than the sampling would have been.
3. **The pause landed on the last task of the chain, so S2c had nothing left to promote.** Rather
   than declare S2c unobservable, §8 creates a fresh round-4 probe task *while paused* — a task
   held back by nothing except the status gate — proving S2a on the sharpest possible case and
   then S2c on resume. This is a deviation from the literal script and a strengthening of it.
4. **The create-chain-while-paused branch was NOT exercised.** The reconciler demonstrably ran on
   the paused project (it settled the re-review task, §7), but that reviewer returned PASS, so
   there was no fix chain to create. Whether the reconciler *would* insert fix-chain rows for a
   paused project remains unobserved here. §7 states this rather than guessing.

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

---

## 3. The whole run, as one timeline

Recorded by a 5-second poller (`/tmp/p8/watch.sh`) that wrote a line only when state changed, so
the absence of a line means the state was byte-identical at every poll in between. All times are
`date -Is`, Europe/Berlin (UTC+2); database columns below are UTC.

```console
=== CHANGE 2026-08-05T23:31:14+02:00
proj=active
0|architect|Plan: p8-s1-s2-consolidation-smoke|running|0|-|a8ba0bfb-a252-4277-85e1-06f152d440fb|running
1|reviewer|Sibling reviewer ALPHA|pending|0|-|-|-
1|reviewer|Sibling reviewer BRAVO|pending|0|-|-|-
=== CHANGE 2026-08-05T23:31:30+02:00
proj=active
0|architect|Plan: p8-s1-s2-consolidation-smoke|running|0|-|a8ba0bfb-a252-4277-85e1-06f152d440fb|completed
1|reviewer|Sibling reviewer ALPHA|pending|0|-|-|-
1|reviewer|Sibling reviewer BRAVO|pending|0|-|-|-
=== CHANGE 2026-08-05T23:31:35+02:00
proj=active
0|architect|Plan: p8-s1-s2-consolidation-smoke|done|0|-|a8ba0bfb-a252-4277-85e1-06f152d440fb|completed
1|reviewer|Sibling reviewer ALPHA|pending|0|-|-|-
1|reviewer|Sibling reviewer BRAVO|pending|0|-|-|-
=== CHANGE 2026-08-05T23:31:45+02:00
proj=active
0|architect|Plan: p8-s1-s2-consolidation-smoke|done|0|-|a8ba0bfb-a252-4277-85e1-06f152d440fb|completed
1|reviewer|Sibling reviewer ALPHA|running|0|-|bf98cc94-b26e-42c2-903f-48f52bd8825f|running
1|reviewer|Sibling reviewer BRAVO|running|0|-|a1a1e94a-94bb-42db-a7ab-d7bf0b9f60c2|running
=== CHANGE 2026-08-05T23:32:00+02:00          <-- O1 WINDOW OPENS
proj=active
0|architect|Plan: p8-s1-s2-consolidation-smoke|done|0|-|a8ba0bfb-a252-4277-85e1-06f152d440fb|completed
1|reviewer|Sibling reviewer ALPHA|running|0|-|bf98cc94-b26e-42c2-903f-48f52bd8825f|completed
1|reviewer|Sibling reviewer BRAVO|running|0|-|a1a1e94a-94bb-42db-a7ab-d7bf0b9f60c2|running
=== CHANGE 2026-08-05T23:32:11+02:00          <-- O1 WINDOW CLOSES
proj=active
0|architect|Plan: p8-s1-s2-consolidation-smoke|done|0|-|a8ba0bfb-a252-4277-85e1-06f152d440fb|completed
1|reviewer|Sibling reviewer ALPHA|running|0|-|bf98cc94-b26e-42c2-903f-48f52bd8825f|completed
1|reviewer|Sibling reviewer BRAVO|running|0|-|a1a1e94a-94bb-42db-a7ab-d7bf0b9f60c2|completed
=== CHANGE 2026-08-05T23:32:16+02:00          <-- CONSOLIDATION FIRES
proj=active
0|architect|Plan: p8-s1-s2-consolidation-smoke|done|0|-|a8ba0bfb-a252-4277-85e1-06f152d440fb|completed
1|reviewer|Sibling reviewer ALPHA|done|0|-|bf98cc94-b26e-42c2-903f-48f52bd8825f|completed
1|reviewer|Sibling reviewer BRAVO|done|0|-|a1a1e94a-94bb-42db-a7ab-d7bf0b9f60c2|completed
2|builder|Fix cycle 1|pending|1|fix:1:1|-|-
3|reviewer|Re-review after fix cycle 1|pending|1|rereview:1:1|-|-
=== CHANGE 2026-08-05T23:32:26+02:00
proj=active
...
2|builder|Fix cycle 1|running|1|fix:1:1|57afb4aa-a3b5-485e-926a-ba8b28463e87|running
3|reviewer|Re-review after fix cycle 1|pending|1|rereview:1:1|-|-
=== CHANGE 2026-08-05T23:33:17+02:00
...
2|builder|Fix cycle 1|running|1|fix:1:1|57afb4aa-a3b5-485e-926a-ba8b28463e87|completed
3|reviewer|Re-review after fix cycle 1|pending|1|rereview:1:1|-|-
=== CHANGE 2026-08-05T23:33:27+02:00
...
2|builder|Fix cycle 1|done|1|fix:1:1|57afb4aa-a3b5-485e-926a-ba8b28463e87|completed
3|reviewer|Re-review after fix cycle 1|pending|1|rereview:1:1|-|-
```

Columns: `round|role|title|task_status|fix_cycle|chain_key|run_id|run_status`. The `...` lines in
the last three blocks are the unchanged rounds 0 and 1, elided for width only; they read exactly as
in the `23:32:16` block.

Note what is **not** in this timeline: no round ≥ 2 row before `23:32:16`, and no second fix
builder or second re-review at any point.

---

## 4. OBSERVATION O1 — the deferral — **PASS, with a stated sampling limitation**

**What the brief expected:** BRAVO was briefed to `sleep 120`, giving a ~2-minute window in which
ALPHA's run had settled while BRAVO's had not, to be sampled at least three times ~10 s apart.

**What actually happened:** BRAVO did not execute a 120-second sleep. Its entire run lasted
25.2 seconds. The window was therefore 13.9 seconds, and **three samples at 10-second spacing were
not possible.** That is a limitation of this evidence run and it is not papered over. What follows
is what *was* observed, plus a stronger proof from durable timestamps.

### 4.1 The window, from the runs table

```console
$ psql "$PGURL" -c "SELECT pt.title, pt.status AS task_status, r.status AS run_status, r.started_at, r.completed_at FROM project_tasks pt LEFT JOIN runs r ON r.id=pt.run_id WHERE pt.project_id='$SCRATCH1' ORDER BY pt.round, pt.created_at"
               title                | task_status | run_status |          started_at           |         completed_at
------------------------------------+-------------+------------+-------------------------------+-------------------------------
 Plan: p8-s1-s2-consolidation-smoke | done        | completed  | 2026-08-05 21:31:05.903857+00 | 2026-08-05 21:31:27.100166+00
 Sibling reviewer ALPHA             | done        | completed  | 2026-08-05 21:31:44.972403+00 | 2026-08-05 21:31:56.353045+00
 Sibling reviewer BRAVO             | done        | completed  | 2026-08-05 21:31:45.022468+00 | 2026-08-05 21:32:10.253401+00
 Fix cycle 1                        | done        | completed  | 2026-08-05 21:32:25.606629+00 | 2026-08-05 21:33:17.089472+00
 Re-review after fix cycle 1        | done        | completed  | 2026-08-05 21:33:36.210909+00 | 2026-08-05 21:34:53.360583+00
 Gate probe DELTA                   | done        | completed  | 2026-08-05 21:37:27.560711+00 | 2026-08-05 21:37:35.995307+00
(6 rows)
```

ALPHA's run reached `completed` at **21:31:56.353045+00**. BRAVO's reached `completed` at
**21:32:10.253401+00**. The deferral window is those 13.902 seconds. The manager loop ticks every
10 s, so **at least one and probably two full ticks elapsed inside it.**

### 4.2 What the engine did during the window — nothing, and the timestamps prove it

```console
$ psql "$PGURL" -c "SELECT round, title, status, created_at, updated_at FROM project_tasks WHERE project_id='$SCRATCH1' ORDER BY round, created_at"
 round |               title                | status |          created_at           |          updated_at
-------+------------------------------------+--------+-------------------------------+-------------------------------
     0 | Plan: p8-s1-s2-consolidation-smoke | done   | 2026-08-05 21:31:03.026256+00 | 2026-08-05 21:31:34.584163+00
     1 | Sibling reviewer ALPHA             | done   | 2026-08-05 21:31:03.120737+00 | 2026-08-05 21:32:14.837798+00
     1 | Sibling reviewer BRAVO             | done   | 2026-08-05 21:31:03.139994+00 | 2026-08-05 21:32:14.839095+00
     2 | Fix cycle 1                        | done   | 2026-08-05 21:32:14.834633+00 | 2026-08-05 21:33:25.230722+00
     3 | Re-review after fix cycle 1        | done   | 2026-08-05 21:32:14.834633+00 | 2026-08-05 21:34:55.719323+00
     4 | Gate probe DELTA                   | done   | 2026-08-05 21:36:08.967061+00 | 2026-08-05 21:37:36.462509+00
(6 rows)
```

Three facts fall straight out of this table, and together they are the O1 assertion:

1. **No round ≥ 2 row existed during the window.** `Fix cycle 1` and `Re-review after fix cycle 1`
   were both created at `21:32:14.834633+00` — **4.58 seconds after the window closed.**
2. **Both reviewer tasks were still `running` throughout the window.** Their `updated_at` values
   are `21:32:14.837798` and `21:32:14.839095` — the first write to either row after they were
   claimed. ALPHA's *run* settled at `21:31:56`, but ALPHA's *task* was not moved to `done` until
   BRAVO settled too. That is precisely the deferral the design calls for: a settled reviewer is
   held at its round until its siblings settle.
3. **The consolidation was atomic.** `Fix cycle 1` and `Re-review after fix cycle 1` share the
   identical `created_at` to the microsecond (`21:32:14.834633+00`), and both reviewer tasks were
   settled 3–4 microseconds later. One transaction, one decision, one chain.

### 4.3 The live sample inside the window

The 5-second poller logged a state change at `23:32:00+02:00` (= `21:32:00+00`), which is
**3.6 s into the 13.9 s window**:

```console
=== CHANGE 2026-08-05T23:32:00+02:00
proj=active
0|architect|Plan: p8-s1-s2-consolidation-smoke|done|0|-|a8ba0bfb-a252-4277-85e1-06f152d440fb|completed
1|reviewer|Sibling reviewer ALPHA|running|0|-|bf98cc94-b26e-42c2-903f-48f52bd8825f|completed
1|reviewer|Sibling reviewer BRAVO|running|0|-|a1a1e94a-94bb-42db-a7ab-d7bf0b9f60c2|running
```

ALPHA `run_status=completed`, `task_status=running`. BRAVO `run_status=running`. No round ≥ 2 row.
The next log line is at `23:32:11`, so the polls at roughly `23:32:05` and `23:32:10` returned
byte-identical state — the poller writes only on change. So the window was observed live across
**three consecutive polls**, though spanning 11 seconds rather than the 30 the brief envisaged.

**Verdict A6: PASS.** A settled reviewer triggered no action while its sibling was unsettled, across
at least one full manager tick, proven both by live sampling and by three independent database
timestamp facts. **Limitation recorded honestly: the window was 13.9 s because BRAVO ignored its
briefed `sleep 120`, so the three-samples-at-10 s-spacing protocol could not be followed.**

**Methodology note for future smokes:** a `sleep 120` written into an agent's brief is not a
reliable way to stagger sibling settle times. BRAVO's final message narrated the delay
("The sleep delay allows the sibling reviewer to complete its work concurrently") while its run
lasted 25.2 s in total. Stagger by creating the second task a minute later, or by giving it real
work, not by asking an agent to sleep.

---

## 5. STEP 6 — S1 assertions on the resulting rows

```console
$ date -Is
2026-08-05T23:35:55+02:00
$ psql "$PGURL" -c "SELECT round, role, title, status, fix_cycle, chain_key FROM project_tasks WHERE project_id='$SCRATCH1' ORDER BY round, created_at"
 round |   role    |               title                | status | fix_cycle |  chain_key
-------+-----------+------------------------------------+--------+-----------+--------------
     0 | architect | Plan: p8-s1-s2-consolidation-smoke | done   |         0 |
     1 | reviewer  | Sibling reviewer ALPHA             | done   |         0 |
     1 | reviewer  | Sibling reviewer BRAVO             | done   |         0 |
     2 | builder   | Fix cycle 1                        | done   |         1 | fix:1:1
     3 | reviewer  | Re-review after fix cycle 1        | done   |         1 | rereview:1:1
(5 rows)
```

(This query ran before the §8 round-4 probe was created, hence 5 rows.)

```console
$ psql "$PGURL" -c "SELECT round, role, title, count(*) FROM project_tasks WHERE project_id='$SCRATCH1' GROUP BY 1,2,3 HAVING count(*) > 1"
 round | role | title | count
-------+------+-------+-------
(0 rows)
```

- **A1 — PASS.** Exactly one row `round=2, role=builder, title='Fix cycle 1'`.
- **A2 — PASS.** Exactly one row `round=3, role=reviewer, title='Re-review after fix cycle 1'`.
- **A3 — PASS.** `chain_key` values are literally `fix:1:1` and `rereview:1:1`, matching
  `chainKeys()` at `src/lib/project-reconcile.ts:161`. `fix_cycle=1` on both, i.e. `max(fix_cycle)+1`
  where the round-1 reviewers carried `fix_cycle=0`.
- **A5 — PASS.** The duplicate-check query returns zero rows.

### 5.1 A4 — the merged feedback in the `Fix cycle 1` brief — **PASS**

```console
$ psql "$PGURL" -tAc "SELECT brief FROM project_tasks WHERE project_id='$SCRATCH1' AND title='Fix cycle 1'" > /tmp/p8/fixbrief.txt
$ grep -n -o 'ALPHA-FEEDBACK-7A1' /tmp/p8/fixbrief.txt
4:ALPHA-FEEDBACK-7A1
$ grep -n -o 'BRAVO-FEEDBACK-7B2' /tmp/p8/fixbrief.txt
11:BRAVO-FEEDBACK-7B2
```

Both tokens present, in one brief. The brief verbatim:

```console
$ cat /tmp/p8/fixbrief.txt
Reviewer feedback from round 1 (fix cycle 1). Address EVERY point below; the re-review will check all of them against your new diff.

## Feedback from: Sibling reviewer ALPHA
ALPHA-FEEDBACK-7A1: Synthetic smoke test executed as specified. Working directory: `/opt/ai-os/workspace/projects/75b2a54f-40b8-4f80-bcc5-698f2a62db3b`. Contents: `.git` and `PLAN.md` only. The scratch README has no purpose line. Reviewer consolidation checkpoint reached with no real artifacts to audit—test framework intact, no corruption of experiment scope.

VERDICT: NEEDS_FIXES

## Feedback from: Sibling reviewer BRAVO
Executing round-1 reviewer checks for the synthetic smoke test. The sleep delay allows the sibling reviewer to complete its work concurrently. The project scaffold contains only PLAN.md as expected for this phase of the goal engine validation.

BRAVO-FEEDBACK-7B2: This synthetic project serves as an experiment harness to verify the consolidation pathway in the goal engine's reviewer orchestration. The scratch project has no test script. No executable tests are present; the project exists only to exercise the architectural review flow without introducing actual code artifacts. The repository state is clean with only the mandatory PLAN.md commit in place, indicating the round-0 architect correctly stopped after establishing the baseline.

VERDICT: NEEDS_FIXES
```

This is the merge working as designed: both reviewers' full final messages, each under a
`## Feedback from: <title>` header, in one brief for one builder.

### 5.2 A7 — the merged feedback in the re-review brief — **PASS**

```console
$ psql "$PGURL" -tAc "SELECT brief FROM project_tasks WHERE project_id='$SCRATCH1' AND title='Re-review after fix cycle 1'" > /tmp/p8/rerevbrief.txt
$ grep -n -o 'ALPHA-FEEDBACK-7A1' /tmp/p8/rerevbrief.txt
9:ALPHA-FEEDBACK-7A1
$ grep -n -o 'BRAVO-FEEDBACK-7B2' /tmp/p8/rerevbrief.txt
16:BRAVO-FEEDBACK-7B2
```

Both tokens present (1951 bytes vs the fix brief's 1371 — the re-review brief wraps the same merged
feedback in its own re-review instructions).

### 5.3 The chain actually functioned, end to end

Not an assertion in the brief, but worth recording: the merged feedback was actionable enough that
the fix builder addressed both points and the re-reviewer verified both independently and returned
PASS. Tail of the re-review's final message (run `d365e08d-1f0b-491d-8d2a-4d8da303bea1`):

```
**ALPHA-7A1 — "The scratch README has no purpose line." → FIXED.**
`README.md:3` now carries an explicit `**Purpose:**` line ...

**BRAVO-7B2 — "The scratch project has no test script." → FIXED.**
`test.sh:1-76`, committed executable (mode `100755`, confirmed in the index). It is a real script,
not a stub: 6 TAP-style invariant checks, exit 1 on any failure.
...
VERDICT: PASS
```

Both consolidated concerns survived the round trip, attributed to their originating reviewer.

---

## 6. STEP 4 — the pause, with a run in flight — **S2b PASS**

The pause was taken against the round-3 re-review run rather than BRAVO's: BRAVO settled 13.9 s
after ALPHA (§4), by which time the whole fix chain had already been created and dispatched. The
round-3 re-review was the next run in flight, and it serves the assertion identically.

```console
$ date -Is
2026-08-05T23:33:53+02:00
$ psql "$PGURL" -tAF'|' -c "SELECT pt.status, pt.run_id, r.status FROM project_tasks pt LEFT JOIN runs r ON r.id=pt.run_id WHERE pt.project_id='$SCRATCH1' AND pt.round=3"
running|d365e08d-1f0b-491d-8d2a-4d8da303bea1|running
```

Run in flight. Pause:

```console
$ date -Is
2026-08-05T23:33:58+02:00
$ curl -sS -X POST http://127.0.0.1:7700/api/projects/$SCRATCH1/status -H 'content-type: application/json' -d '{"status":"paused"}'
{"project":{"id":"75b2a54f-40b8-4f80-bcc5-698f2a62db3b","name":"p8-s1-s2-consolidation-smoke",...,"status":"paused","metadata":{},"created_at":"2026-08-05 21:31:03.026256+00","updated_at":"2026-08-05 21:33:58.532824+00"}}
```

**Pause committed at `21:33:58.532824+00`** (the project row's own `updated_at`, not a client clock).

The in-flight run then continued for another **54.8 seconds** and finished normally:

```console
$ psql "$PGURL" -c "SELECT id, status, started_at, completed_at FROM runs WHERE id='d365e08d-1f0b-491d-8d2a-4d8da303bea1'"
                  id                  |  status   |          started_at           |         completed_at
--------------------------------------+-----------+-------------------------------+-------------------------------
 d365e08d-1f0b-491d-8d2a-4d8da303bea1 | completed | 2026-08-05 21:33:36.210909+00 | 2026-08-05 21:34:53.360583+00
(1 row)
```

`status = 'completed'`, not `cancelled`, not `stuck`. **Verdict S2b: PASS.** Pausing a project stops
new claims; it does not kill work already in flight, exactly as `src/db/projects.ts` documents.

---

## 7. STEP 4 continued — S2a over 8 snapshots — **PASS**

Eight snapshots, `23:34:11` → `23:35:23` (72 seconds, ≥ 7 manager ticks). Snapshots 1–5 and 6–8 are
identical within each group; both groups are reproduced in full, the repeats elided with their
timestamps kept.

```console
=== PAUSED SNAPSHOT 1  2026-08-05T23:34:11+02:00
 project_status
----------------
 paused
(1 row)

 round |               title                | task_status | run_status
-------+------------------------------------+-------------+------------
     0 | Plan: p8-s1-s2-consolidation-smoke | done        | completed
     1 | Sibling reviewer ALPHA             | done        | completed
     1 | Sibling reviewer BRAVO             | done        | completed
     2 | Fix cycle 1                        | done        | completed
     3 | Re-review after fix cycle 1        | running     | running
(5 rows)

 run_count
-----------
         5
(1 row)

                  id                  | status  |          started_at           | completed_at
--------------------------------------+---------+-------------------------------+--------------
 d365e08d-1f0b-491d-8d2a-4d8da303bea1 | running | 2026-08-05 21:33:36.210909+00 |
(1 row)
```

Snapshots 2 (`23:34:21`), 3 (`23:34:31`), 4 (`23:34:42`), 5 (`23:34:52`): **byte-identical to
snapshot 1.** Project `paused`, round 3 `running`, `run_count = 5`.

```console
=== PAUSED SNAPSHOT 6  2026-08-05T23:35:02+02:00
 project_status
----------------
 paused
(1 row)

 round |               title                | task_status | run_status
-------+------------------------------------+-------------+------------
     0 | Plan: p8-s1-s2-consolidation-smoke | done        | completed
     1 | Sibling reviewer ALPHA             | done        | completed
     1 | Sibling reviewer BRAVO             | done        | completed
     2 | Fix cycle 1                        | done        | completed
     3 | Re-review after fix cycle 1        | done        | completed
(5 rows)

 run_count
-----------
         5
(1 row)

                  id                  |  status   |          started_at           |         completed_at
--------------------------------------+-----------+-------------------------------+-------------------------------
 d365e08d-1f0b-491d-8d2a-4d8da303bea1 | completed | 2026-08-05 21:33:36.210909+00 | 2026-08-05 21:34:53.360583+00
(1 row)
```

Snapshots 7 (`23:35:12`) and 8 (`23:35:23`): **byte-identical to snapshot 6.**

**`run_count` was 5 in all eight snapshots.** No task moved from `pending` to `ready` or `running`.

### 7.1 The reconciler DID act on a paused project — stated plainly

Between snapshot 5 and snapshot 6 the round-3 task moved `running` → `done` **while the project was
`paused`** (task `updated_at = 21:34:55.719323+00`; pause at `21:33:58.53`, resume at
`21:37:24.84`). So `reconcileSettledTasks()` is confirmed *not* gated on project status in the
deployed engine, matching the comment at `src/db/projects.ts:434`.

**However — and this is the honest limit of this observation — the create-chain branch was never
reached.** That re-reviewer returned `VERDICT: PASS` (§5.3), so consolidation had no fix chain to
create. **Whether the reconciler would insert fix-chain rows for a paused project is NOT observed by
this evidence run.** It settled a task while paused; it was never asked to create one while paused.
Proving that branch needs a separate smoke where a reviewer returns NEEDS_FIXES with the project
already paused.

**Verdict S2a: PASS.** Across ≥ 7 ticks while paused: no promotion, no new claim, no new run.
Section 8 tests the same gate against a task that had nothing *but* the status gate holding it back.

---

## 8. Round-4 probe — S2a on the sharp case, and S2c — **PASS**

**Deviation from the literal script, declared.** The brief's step 5 expects "the round-2 task
promotes" on resume. By the time the pause landed, every task in the project was `done` — the pause
had caught the final task of the chain — so there was nothing left to promote and S2c as written was
unobservable. Instead of reporting it unobservable, a fresh round-4 task was created **while the
project was paused**. Nothing gated it except `p.status = 'active'`: all earlier rounds were `done`,
so the round gate was satisfied and the status gate was the only thing standing between it and a
claim. That is a stricter test of S2a than the §7 window and it makes S2c observable.

Creating tasks in this scratch project is within scope; no task was created in the parent project.

```console
$ date -Is
2026-08-05T23:36:08+02:00
$ curl -sS -X POST http://127.0.0.1:7700/api/projects/$SCRATCH1/tasks -H 'content-type: application/json' -d @/tmp/p8_delta.json
{"task":{"id":"a876c732-033b-4dfb-a120-bf61eeccae82","project_id":"75b2a54f-40b8-4f80-bcc5-698f2a62db3b","round":4,"role":"builder","title":"Gate probe DELTA","brief":"SYNTHETIC ENGINE TEST — promotion-gate probe. Do EXACTLY this and nothing more: run `pwd`, then write a one-sentence final message containing the token DELTA-PROBE-7D4. Do NOT create tasks. Do NOT call the forge-control API. Do NOT edit anything outside this worktree. Do NOT run pm2.","status":"pending","run_id":null,"fix_cycle":0,"tier":"fast","attempt":0,"chain_key":null,"created_at":"2026-08-05 21:36:08.967061+00","updated_at":"2026-08-05 21:36:08.967061+00"}}
```

### 8.1 Held inert for 61 seconds / ≥ 6 ticks

```console
=== GATE SNAPSHOT 1  2026-08-05T23:36:14+02:00
 project_status | run_count
----------------+-----------
 paused         |         5
(1 row)

 round |      title       | status  | run_id
-------+------------------+---------+--------
     4 | Gate probe DELTA | pending | -
(1 row)
```

Snapshots 2 (`23:36:24`), 3 (`23:36:34`), 4 (`23:36:44`), 5 (`23:36:54`), 6 (`23:37:05`):
**byte-identical.** `paused` / `run_count = 5` / `pending` / no `run_id`, every one.

**Verdict S2a: PASS**, now on the sharp case — a fully promotable task, held by nothing but
`AND p.status = 'active'`, sat `pending` across six consecutive manager ticks.

### 8.2 STEP 5 — resume — **S2c PASS**

```console
=== BEFORE RESUME 2026-08-05T23:37:24+02:00
 round |      title       | status  | run_id
-------+------------------+---------+--------
     4 | Gate probe DELTA | pending | -
(1 row)

=== T_RESUME 2026-08-05T23:37:24+02:00
$ curl -sS -X POST http://127.0.0.1:7700/api/projects/$SCRATCH1/status -H 'content-type: application/json' -d '{"status":"active"}'
{"project":{"id":"75b2a54f-40b8-4f80-bcc5-698f2a62db3b",...,"status":"active","metadata":{},"created_at":"2026-08-05 21:31:03.026256+00","updated_at":"2026-08-05 21:37:24.84403+00"}}

=== AFTER RESUME +1x5s  2026-08-05T23:37:29+02:00
 round |      title       | status  |                run_id
-------+------------------+---------+--------------------------------------
     4 | Gate probe DELTA | running | 54841185-9f5b-4dfe-bd5a-be6242e45c47
(1 row)

=== AFTER RESUME +3x5s  2026-08-05T23:37:39+02:00
 round |      title       | status |                run_id
-------+------------------+--------+--------------------------------------
     4 | Gate probe DELTA | done   | 54841185-9f5b-4dfe-bd5a-be6242e45c47
(1 row)
```

Snapshots +4 through +10 (`23:37:45` … `23:38:15`): `done`, same `run_id`, unchanged.

Resume committed at `21:37:24.844030+00`; the probe's run started at `21:37:27.560711+00` — **2.72
seconds later, inside a single tick.** The brief allowed ~30 s / 3 ticks.

**Verdict S2c: PASS.** Promotion and claim both resumed on the first tick after the status flipped
back to `active`. The pending row was not lost, not skipped, and needed no nudge.

---

## 9. STEP 7 — close the scratch project

```console
$ date -Is
2026-08-05T23:38:26+02:00
$ curl -sS -X POST http://127.0.0.1:7700/api/projects/$SCRATCH1/status -H 'content-type: application/json' -d '{"status":"done"}'
{"project":{"id":"75b2a54f-40b8-4f80-bcc5-698f2a62db3b","name":"p8-s1-s2-consolidation-smoke",...,"status":"done","metadata":{},"created_at":"2026-08-05 21:31:03.026256+00","updated_at":"2026-08-05 21:38:26.899272+00"}}
```

Final row state — nothing in flight, nothing orphaned, six tasks, all `done`:

```console
$ psql "$PGURL" -c "SELECT round, title, status FROM project_tasks WHERE project_id='$SCRATCH1' ORDER BY round, created_at"
 round |               title                | status
-------+------------------------------------+--------
     0 | Plan: p8-s1-s2-consolidation-smoke | done
     1 | Sibling reviewer ALPHA             | done
     1 | Sibling reviewer BRAVO             | done
     2 | Fix cycle 1                        | done
     3 | Re-review after fix cycle 1        | done
     4 | Gate probe DELTA                   | done
(6 rows)
```

No run was still in flight at close, so none was left dangling and none was killed.

**Total cost of the experiment: 6 runs on the `fast` tier.**

---

## 10. Divergence between the unit tests and the deployed engine

**None found.** Every behaviour `project-reconcile.ts` is unit-tested for was reproduced by the
deployed engine on the first attempt:

| Unit-tested behaviour | Deployed engine |
|---|---|
| wait while ANY reviewer in the round is unsettled | held ALPHA's task `running` for 13.9 s until BRAVO settled (§4.2) |
| any NEEDS_FIXES → ONE fix chain | exactly one `Fix cycle 1` + one `Re-review after fix cycle 1` (§5) |
| chain keys `fix:<round>:<cycle>` / `rereview:<round>:<cycle>` | `fix:1:1`, `rereview:1:1` (§5) |
| cycle = `max(fix_cycle)+1` | `fix_cycle=1` from reviewers at `fix_cycle=0` (§5) |
| feedback merged across reviewers | both tokens in both briefs, attributed per reviewer (§5.1, §5.2) |
| `promoteReadyTasks`/`claimReadyTasks` gated on `p.status='active'` | probe held `pending` 6 ticks paused, claimed 2.72 s after resume (§8) |
| reconciler NOT gated on project status | settled the round-3 task while paused (§7.1) |
| pause does not kill in-flight runs | run continued 54.8 s past the pause, `completed` (§6) |

### Two gaps this run did NOT close

1. **The create-chain-while-paused branch is unexercised** (§7.1). The reconciler was proven to run
   while paused, but the only verdict it processed while paused was PASS.
2. **The N≥2 path was exercised with N=2 and both siblings NEEDS_FIXES.** Not exercised live: the
   mixed PASS + NEEDS_FIXES race, the unparseable-verdict → block path, and N≥3. All three are
   covered by unit tests; none has now been seen in production.

Neither gap is a defect. Both are scope for a follow-up smoke if the phase wants that coverage.

---

## 11. Compliance with this task's hard rules

- `/opt/forge-ai-os` was never edited. Verified — the only file written this round is this evidence
  file, in this worktree.
- No `pm2 restart` was issued against anything. `pm2 jlist` and `pm2 env 35` (both read-only) were
  the only pm2 calls.
- **Every database statement was a `SELECT`.** No INSERT/UPDATE/DELETE/DDL was issued. All state
  changes to the scratch project went through the forge-control HTTP API.
- No task was created in the parent project `4120f785-fd86-414c-9a04-f10b2cd0c365`. The six tasks in
  scratch project `75b2a54f-40b8-4f80-bcc5-698f2a62db3b` are the entirety of what this round created.
- No shell command slept longer than 120 s; all waits were `sleep 5` loops with per-tick output.
- The `DATABASE_URL` password appears nowhere in this file; every command is written as `psql "$PGURL"`.
