# Evidence — Phase 8D: the post-restart seeding watcher, the three payloads, and the instrument-typecheck gate

Round 802. Builder transcript. Worktree only: nothing in this round touched
`/opt/forge-ai-os`, the live database, or a live endpoint. Every HTTP request
made while proving this work went to a throwaway python3 server on an ephemeral
port; every `pm2` read went to a shell shim printing a canned string.

---

## 1. What was built, and why each piece exists

| File | What it is |
|---|---|
| `scripts/deploy/await-and-seed.sh` | The detached watcher. Waits for a condition, then POSTs one task. |
| `scripts/deploy/payload-verify.json` | The round-815 live-verification task, POSTed by the watcher in `executor-restart` mode. |
| `scripts/deploy/payload-report.json` | The round-817 DoD-6 measurement task, POSTed in `project-done` mode. |
| `scripts/deploy/payload-review.json` | The round-819 gating reviewer, POSTed by the report task itself. |
| `scripts/checks/check-await-seed.sh` | Drives the watcher against fakes. 7 cases, 56 assertions, censused. |
| `scripts/checks/check-instrument-typecheck.sh` | Universal gate item 9. Compiles **every** instrument under `scripts/checks/`, enumerated by glob at run time, one per `tsc` invocation. *(Rewritten at round 500 by `docs/plan/scripts-checks-typecheck-gate/`; at round 802 it compiled only the manifested seven.)* |
| `scripts/checks/instrument-manifest.txt` | The gate's **waiver ledger** — instruments whose failure is excused, with a diagnostic, a reason and an owner; target state empty, and empty today. It does not scope the gate. *(Round 802 used it as an inclusion list; superseded at round 500.)* |

**The problem the watcher solves, restated so nobody re-derives it.**
`/opt/ai-os/scripts/safe-restart.sh` waits for the WHOLE FLEET to go quiet —
`SELECT count(*) FROM runs WHERE last_heartbeat_at > now() - interval '45
seconds'`, two consecutive quiet polls 15s apart — before it touches the
executor. The manager tick promotes any ready task of an active project within
about ten seconds of the previous round draining. Those two facts compose into a
task that cannot do its job: a verification row numbered above the deploy would
run BEFORE the restart it exists to verify (against the old engine, still
resident in the executor's memory) and would DELAY that restart by its own
duration, because a running task holds a heartbeat.

A bigger round number does not fix it; nothing fixes it while the verifier is a
fleet run. So it stops being one. The watcher is launched detached, appears in no
`runs` row, holds no heartbeat, and therefore cannot block the idle window it is
waiting on. It fires once, after the condition is OBSERVED true, and only then
does a task row exist.

---

## 2. `await-and-seed.sh` — the contract, and the five things that could make it lie

Two modes:

```
await-and-seed.sh executor-restart <payload.json> [--substitute KEY=VALUE]...
await-and-seed.sh project-done <uuid> <payload.json> [--substitute KEY=VALUE]...
```

`executor-restart` captures `forge-executor`'s `restart_time` and `pm_uptime`
from `pm2 jlist` (parsed with `python3`; `jq` is not guaranteed on this box)
BEFORE its first poll, and fires only when all three hold: `restart_time` has
strictly increased past the captured value, `pm2_env.status == "online"`, and
`pm_uptime` is later than the watcher's own launch. `project-done` polls
`GET /api/projects/<uuid>` and fires on `project.status == "done"`.

On firing it POSTs the reactivation FIRST —
`POST /api/projects/8c591d6c-…/status {"status":"active"}` — then the task.
The order is load-bearing: `createTask()` does not reactivate a project and
`promoteReadyTasks()` carries `AND p.status = 'active'`, so a row POSTed into a
project that has already closed is a row that never runs. A `409` on the task
POST is a SUCCESS and is logged as one: migration 0035's identity
`(project, round, role, title)` means the row already exists and the response
carries its original id, so re-running the watcher can never fan out a duplicate
agent.

It never restarts anything. The prohibited command (R66) does not appear in it in
any form — verified in §6 below, where the corpus-wide sweep still returns
exactly its four known hits.

**What would have made it report a success wrongly** — the five mechanisms are
written into the script's own header and each is closed:

1. **Firing on a restart that predates it.** A watcher that only tests
   `status == "online"` fires immediately, because the executor is online right
   now. Closed by capturing the baseline before the first poll and requiring a
   strict increase past it; the captured values are printed on the provenance
   line, so the transcript records what was compared against. An UNREADABLE
   baseline at launch is a hard error, never a zero — a zero baseline would be
   beaten by the current `restart_time` on the first poll.
2. **Seeding a payload full of placeholders.** Closed by the token guard, §3.
3. **Running twice and fanning out two agents.** Closed by 0035's identity and
   the 409-is-success rule.
4. **Seeding into a closed project so nothing promotes.** Closed by the
   reactivation-first order above.
5. **Deciding from unreadable input.** Every reader answers an explicit
   `unknown` that the fire test rejects and the log names, so "pm2 hiccuped for
   one poll" can never drift into "the condition was met".

Testability hooks, all with production defaults: `AWAIT_SEED_PM2_CMD`
(`pm2 jlist`), `AWAIT_SEED_API` (`http://127.0.0.1:7700`), `AWAIT_SEED_POLL`
(30s in `executor-restart`, 60s in `project-done`), `AWAIT_SEED_TIMEOUT`
(46800s = `safe-restart.sh`'s own 43200s ceiling plus an hour of margin, so the
watcher outlives safe-restart's give-up decision and can report it rather than
race it), `AWAIT_SEED_SERVICE` (`forge-executor`).

---

## 3. FINDING — the token guard collides with any brief that quotes a launch line

**This is a real finding, not a footnote, and it changed two of the three
payloads.**

The specification is unambiguous: a payload that still carries an unsubstituted
`__…__` token at POST time is a hard error that seeds nothing. That guard is
what stops a task shipping with `write_set: ["…/after-<a literal token>.md"]`,
which would look plausible in the Kanban and be worthless.

But the guard scans the whole rendered payload, and a payload's `brief` is part
of it. Two of the three briefs specified for this round QUOTE an
`await-and-seed.sh` launch line — `payload-verify.json`'s item 8 quotes
`--substitute __DOD6_PROJECT_ID__=<NEW_ID>` and `payload-report.json`'s item 7
quotes `sed "s/__REPORT_TASK_ID__/$MY_TASK_ID/g"`. Written literally:

- `payload-verify.json` is POSTed with **no** substitutions at all, so its quoted
  `__DOD6_PROJECT_ID__` would be an unsubstituted token → the watcher refuses,
  seeds nothing, and phase 8 stops dead at the restart.
- `payload-report.json` is POSTed with `--substitute __DOD6_PROJECT_ID__=<id>`,
  which leaves its quoted `__REPORT_TASK_ID__` → same refusal, one step later.

Three repairs were considered:

| option | rejected because |
|---|---|
| Weaken the guard to structural fields only | The brief IS how the next worker learns what to do; a placeholder there is as harmful as one in `write_set`, and "it looked like documentation" is exactly how a placeholder reaches production. |
| Add a `--defer TOKEN` flag | The launch line for `payload-report.json` is dictated verbatim by the round-800 planner and carries no such flag, so the flag would exist and never be passed. |
| **Build the token at runtime in the quoted command** | **Taken.** |

Both briefs now write `TOK="$(printf '__%s__' DOD6_PROJECT_ID)"` (respectively
`REPORT_TASK_ID`) and use `"$TOK"` in the command. The commands remain
verbatim-executable bash, every id stays intact, and no contiguous token exists
in the payload. Each brief explains why at the site, so the next reader does not
"simplify" it back. `payload-review.json` keeps `__REPORT_TASK_ID__` spelled
literally in `depends_on` — it is never rendered by the watcher; the report task
substitutes it with its own `sed`.

Measured, and this is the guard's whole point:

```
payload-verify.json  tokens: none
payload-report.json  tokens: ['__DOD6_PROJECT_ID__']      <- substituted at launch
payload-review.json  tokens: ['__REPORT_TASK_ID__']       <- substituted by the report task
```

**Guard behaviour is fail-fast, which is stronger than the spec asks for.** The
check runs at LAUNCH over the rendered bytes — the exact bytes that will be
POSTed hours later — and again immediately before the POST. Refusing at launch
refuses the same payload, seeds the same nothing, and tells the operator now
instead of thirteen hours later. The pre-POST call is the belt: the same function
over the same string, so a future edit that mutates the body between launch and
fire cannot slip past. Case 4 of `check-await-seed.sh` exercises the launch call.

---

## 4. `check-await-seed.sh` — 7 cases, 56 assertions, censused both ways

> **Round 804 raised this from 6/49 to 7/56.** Case 7 refuses the manager
> message and asserts the watcher warns rather than reporting it as notified
> (finding 2 — §4.2). The transcript pasted below is the **round-802 run at
> `3dd39b4`, before case 7 existed**; it is left byte-intact rather than
> regenerated, and the current run's census is appended after it.

It drives the real watcher against a shell shim for `pm2 jlist` and a throwaway
python3 HTTP server on an ephemeral port that RECORDS every request (method,
path, body) as JSONL and answers with codes the check chooses. Nothing reaches
127.0.0.1:7700.

Case 1 asserts an ABSENCE, and an absence is also what a crashed watcher, an
unexecuted shim or an unbound recorder produce. So it is guarded three ways: the
shim appends to a call log and the case asserts it was called at least three
times; the watcher's transcript must carry at least three "not firing" lines
naming the baseline; and the recorder is proved reachable by a liveness GET
before case 1 runs.

FULL TRANSCRIPT:

```
check-await-seed.sh — engine-task-graph phase 8D (await-and-seed.sh)

BUILD IDENTITY OF THE CODE UNDER TEST
  worktree path    : /opt/ai-os/workspace/projects/8c591d6c-5642-4fd6-97ef-e0aeb2dbf2b4
  git HEAD         : 3dd39b4939cfbefec76f2ef184a601676b796d76
  git branch       : project/8c591d6c
  subject          : /opt/ai-os/workspace/projects/8c591d6c-5642-4fd6-97ef-e0aeb2dbf2b4/scripts/deploy/await-and-seed.sh
  subject sha256   : efe79f2c53686e63ee565c1a1721621d7e44f3439d2fae397b90227455dfb869   <-- authoritative
  subject dirty    : ?? scripts/deploy/await-and-seed.sh
  this check sha256: 9e88876b14a33ada7dfa24702a26b23b506f0b3930ed3b0f8760cb94ff593d67
  bash             : 5.2.21(1)-release
  python3          : Python 3.12.3
  curl             : curl 8.5.0 (x86_64-pc-linux-gnu) libcurl/8.5.0 OpenSSL/3.0.13 zlib/1.3 brotli/1.1.0 zstd/1.5.5 libidn2/2.3.7 libpsl/0.21.2 (+libidn2/2.3.7) libssh/0.10.6/openssl/zlib nghttp2/1.59.0 librtmp/2.3 OpenLDAP/2.6.10

recorder listening on http://127.0.0.1:44149 (pid 1449572), request log /tmp/tmp.yYw3tP2Iql/requests.jsonl

CASE 1 — the restart counter is UNMOVED: the watcher POSTs NOTHING
      --- case1.log ---
      [2026-08-18T04:33:49+02:00] await-and-seed: provenance head=3dd39b4 self-sha256=efe79f2c53686e63ee565c1a1721621d7e44f3439d2fae397b90227455dfb869 mode=executor-restart payload=/tmp/tmp.yYw3tP2Iql/payload-ok.json launched=2026-08-18T04:33:49+02:00 baseline=[restart_time=7 pm_uptime=900000 status=online service=forge-executor] poll=1s timeout=600s api=http://127.0.0.1:44149
      [2026-08-18T04:33:49+02:00] await-and-seed: substitutions: none
      [2026-08-18T04:33:49+02:00] await-and-seed: waiting for: forge-executor to restart past restart_time=7 and come back online
      [2026-08-18T04:33:49+02:00] await-and-seed: poll: restart_time=7 has not passed the baseline 7 (status=online) — not firing
      [2026-08-18T04:33:50+02:00] await-and-seed: poll: restart_time=7 has not passed the baseline 7 (status=online) — not firing
      [2026-08-18T04:33:51+02:00] await-and-seed: poll: restart_time=7 has not passed the baseline 7 (status=online) — not firing
      [2026-08-18T04:33:52+02:00] await-and-seed: poll: restart_time=7 has not passed the baseline 7 (status=online) — not firing
      [2026-08-18T04:33:53+02:00] await-and-seed: poll: restart_time=7 has not passed the baseline 7 (status=online) — not firing
      --- end ---
  ok   1.1 no request of any kind reached the API               = 0
  ok   1.2 the pm2 shim was really called (probe reached)       >= 3 (got 6)
  ok   1.3 the transcript shows repeated refusals               >= 3 (got 5)
  ok   1.4 it names the baseline it compared against            contains: has not passed the baseline 7
  ok   1.5 the provenance line came first                       contains: provenance head=
  ok   1.6 the provenance line carries its own sha256           contains: self-sha256=efe79f2c53686e63ee565c1a1721621d7e44f3439d2fae397b90227455dfb869
  ok   1.7 the provenance line carries the baseline             contains: baseline=[restart_time=7 pm_uptime=900000 status=online
  ok   1.8 it was still running when we killed it               != 0

CASE 2 — the counter MOVES and status is online: exactly one seeding, status POST first
      --- case2.log ---
      [2026-08-18T04:33:54+02:00] await-and-seed: provenance head=3dd39b4 self-sha256=efe79f2c53686e63ee565c1a1721621d7e44f3439d2fae397b90227455dfb869 mode=executor-restart payload=/tmp/tmp.yYw3tP2Iql/payload-ok.json launched=2026-08-18T04:33:54+02:00 baseline=[restart_time=7 pm_uptime=900000 status=online service=forge-executor] poll=1s timeout=600s api=http://127.0.0.1:44149
      [2026-08-18T04:33:54+02:00] await-and-seed: substitutions: none
      [2026-08-18T04:33:54+02:00] await-and-seed: waiting for: forge-executor to restart past restart_time=7 and come back online
      [2026-08-18T04:33:54+02:00] await-and-seed: poll: restart_time=7 has not passed the baseline 7 (status=online) — not firing
      [2026-08-18T04:33:55+02:00] await-and-seed: poll: restart_time=7 has not passed the baseline 7 (status=online) — not firing
      [2026-08-18T04:33:56+02:00] await-and-seed: FIRE: forge-executor restarted — restart_time 7 -> 8, status=online, pm_uptime=1787020441000 (launch 1787020434000)
      [2026-08-18T04:33:56+02:00] await-and-seed: POST http://127.0.0.1:44149/api/projects/8c591d6c-5642-4fd6-97ef-e0aeb2dbf2b4/status {"status":"active"}
      [2026-08-18T04:33:56+02:00] await-and-seed:   reactivated: HTTP 200
      [2026-08-18T04:33:56+02:00] await-and-seed: POST http://127.0.0.1:44149/api/projects/8c591d6c-5642-4fd6-97ef-e0aeb2dbf2b4/tasks  <- payload-ok.json
      [2026-08-18T04:33:56+02:00] await-and-seed:   SEEDED: HTTP 201 — {"task": {"id": "11111111-2222-4333-8444-555555555555"}}
      [2026-08-18T04:33:56+02:00] await-and-seed: done — exit 0
      --- end ---
      requests seen:
        POST /api/projects/8c591d6c-5642-4fd6-97ef-e0aeb2dbf2b4/status
        POST /api/projects/8c591d6c-5642-4fd6-97ef-e0aeb2dbf2b4/tasks
  ok   2.1 the watcher exited 0                                 = 0
  ok   2.2 exactly two requests were made                       = 2
  ok   2.3 the FIRST request is the reactivation                = POST /api/projects/8c591d6c-5642-4fd6-97ef-e0aeb2dbf2b4/status
  ok   2.4 the SECOND request is the task POST                  = POST /api/projects/8c591d6c-5642-4fd6-97ef-e0aeb2dbf2b4/tasks
  ok   2.5 exactly one task POST, never two                     = 1
  ok   2.6 the reactivation body is status:active               contains: {"status":"active"}
  ok   2.7 the task body is the rendered payload                contains: check-await-seed fake task
  ok   2.8 it refused the baseline BEFORE the flip              contains: has not passed the baseline 7
  ok   2.9 the FIRE line names the transition                   contains: restart_time 7 -> 8
  ok   2.10 it logged the 201                                   contains: SEEDED: HTTP 201
  ok   2.11 no manager-chat message was needed                  no: /message

CASE 3 — a 409 on the task POST is SUCCESS and is logged as such
      --- case3.log ---
      [2026-08-18T04:33:56+02:00] await-and-seed: provenance head=3dd39b4 self-sha256=efe79f2c53686e63ee565c1a1721621d7e44f3439d2fae397b90227455dfb869 mode=executor-restart payload=/tmp/tmp.yYw3tP2Iql/payload-ok.json launched=2026-08-18T04:33:56+02:00 baseline=[restart_time=8 pm_uptime=900000 status=online service=forge-executor] poll=1s timeout=600s api=http://127.0.0.1:44149
      [2026-08-18T04:33:56+02:00] await-and-seed: substitutions: none
      [2026-08-18T04:33:56+02:00] await-and-seed: waiting for: forge-executor to restart past restart_time=8 and come back online
      [2026-08-18T04:33:56+02:00] await-and-seed: poll: restart_time=8 has not passed the baseline 8 (status=online) — not firing
      [2026-08-18T04:33:57+02:00] await-and-seed: poll: restart_time=8 has not passed the baseline 8 (status=online) — not firing
      [2026-08-18T04:33:58+02:00] await-and-seed: FIRE: forge-executor restarted — restart_time 8 -> 9, status=online, pm_uptime=1787020443000 (launch 1787020436000)
      [2026-08-18T04:33:58+02:00] await-and-seed: POST http://127.0.0.1:44149/api/projects/8c591d6c-5642-4fd6-97ef-e0aeb2dbf2b4/status {"status":"active"}
      [2026-08-18T04:33:58+02:00] await-and-seed:   reactivated: HTTP 200
      [2026-08-18T04:33:58+02:00] await-and-seed: POST http://127.0.0.1:44149/api/projects/8c591d6c-5642-4fd6-97ef-e0aeb2dbf2b4/tasks  <- payload-ok.json
      [2026-08-18T04:33:58+02:00] await-and-seed:   ALREADY SEEDED (409 treated as SUCCESS — identity (project, round, role, title) already exists, migration 0035): {"task": {"id": "11111111-2222-4333-8444-555555555555"}, "error": "duplicate task: this project already has a task with that round/role/title"}
      [2026-08-18T04:33:58+02:00] await-and-seed: done — exit 0
      --- end ---
  ok   3.1 a 409 exits 0 — it is a success                    = 0
  ok   3.2 the transcript calls it a SUCCESS                    contains: 409 treated as SUCCESS
  ok   3.3 it names the identity that already exists            contains: (project, round, role, title)
  ok   3.4 the API's duplicate message is quoted                contains: duplicate task
  ok   3.5 it still POSTed exactly once                         = 1

CASE 4 — an unsubstituted __TOKEN__ seeds NOTHING and exits non-zero
      --- case4.log ---
      [2026-08-18T04:33:58+02:00] await-and-seed: provenance head=3dd39b4 self-sha256=efe79f2c53686e63ee565c1a1721621d7e44f3439d2fae397b90227455dfb869 mode=executor-restart payload=/tmp/tmp.yYw3tP2Iql/payload-token.json launched=2026-08-18T04:33:58+02:00 baseline=[restart_time=9 pm_uptime=900000 status=online service=forge-executor] poll=1s timeout=600s api=http://127.0.0.1:44149
      [2026-08-18T04:33:58+02:00] await-and-seed: substitutions: none
      [2026-08-18T04:33:58+02:00] await-and-seed: HARD ERROR (at launch): the rendered payload still carries unsubstituted token(s): __DOD6_PROJECT_ID__ 
      [2026-08-18T04:33:58+02:00] await-and-seed:   payload      : /tmp/tmp.yYw3tP2Iql/payload-token.json
      [2026-08-18T04:33:58+02:00] await-and-seed:   substitutions: none
      [2026-08-18T04:33:58+02:00] await-and-seed:   seeding NOTHING.
      [2026-08-18T04:33:58+02:00] await-and-seed: manager chat notified (HTTP 202)
      --- end ---
  ok   4.1 it exits non-zero                                    exit 1
  ok   4.2 the reason is the token guard, not a crash           = 1
  ok   4.3 the offending token is NAMED                         contains: __DOD6_PROJECT_ID__
  ok   4.4 it says it seeded nothing                            contains: seeding NOTHING
  ok   4.5 no reactivation POST                                 = 0
  ok   4.6 no task POST                                         = 0
  ok   4.7 exactly one manager-chat message                     = 1
  ok   4.8 the message names the payload                        contains: payload-token.json

CASE 5 — on TIMEOUT it seeds nothing, tells the manager, exits non-zero
      --- case5.log ---
      [2026-08-18T04:33:59+02:00] await-and-seed: provenance head=3dd39b4 self-sha256=efe79f2c53686e63ee565c1a1721621d7e44f3439d2fae397b90227455dfb869 mode=executor-restart payload=/tmp/tmp.yYw3tP2Iql/payload-ok.json launched=2026-08-18T04:33:59+02:00 baseline=[restart_time=9 pm_uptime=900000 status=online service=forge-executor] poll=1s timeout=3s api=http://127.0.0.1:44149
      [2026-08-18T04:33:59+02:00] await-and-seed: substitutions: none
      [2026-08-18T04:33:59+02:00] await-and-seed: waiting for: forge-executor to restart past restart_time=9 and come back online
      [2026-08-18T04:33:59+02:00] await-and-seed: poll: restart_time=9 has not passed the baseline 9 (status=online) — not firing
      [2026-08-18T04:34:00+02:00] await-and-seed: poll: restart_time=9 has not passed the baseline 9 (status=online) — not firing
      [2026-08-18T04:34:01+02:00] await-and-seed: poll: restart_time=9 has not passed the baseline 9 (status=online) — not firing
      [2026-08-18T04:34:02+02:00] await-and-seed: poll: restart_time=9 has not passed the baseline 9 (status=online) — not firing
      [2026-08-18T04:34:02+02:00] await-and-seed: TIMEOUT after 3s (ceiling 3s) — waiting for: forge-executor to restart past restart_time=9 and come back online. SEEDING NOTHING.
      [2026-08-18T04:34:02+02:00] await-and-seed: manager chat notified (HTTP 202)
      --- end ---
  ok   5.1 it exits non-zero                                    exit 2
  ok   5.2 and specifically with 2, the timeout code            = 2
  ok   5.3 the transcript says TIMEOUT                          contains: TIMEOUT after
  ok   5.4 it says it seeded nothing                            contains: SEEDING NOTHING
  ok   5.5 no reactivation POST                                 = 0
  ok   5.6 no task POST                                         = 0
  ok   5.7 exactly one manager-chat message                     = 1
  ok   5.8 the message says WHAT it was waiting for             contains: to restart past restart_time=9
  ok   5.9 the message says nothing was seeded                  contains: seeded NOTHING

CASE 6 — project-done mode fires on status=done and not before
      --- case6.log ---
      [2026-08-18T04:34:02+02:00] await-and-seed: provenance head=3dd39b4 self-sha256=efe79f2c53686e63ee565c1a1721621d7e44f3439d2fae397b90227455dfb869 mode=project-done payload=/tmp/tmp.yYw3tP2Iql/payload-token.json launched=2026-08-18T04:34:02+02:00 baseline=[project=aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee status=active] poll=1s timeout=600s api=http://127.0.0.1:44149
      [2026-08-18T04:34:02+02:00] await-and-seed: substitutions: __DOD6_PROJECT_ID__=aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee
      [2026-08-18T04:34:02+02:00] await-and-seed: waiting for: project aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee to reach status=done
      [2026-08-18T04:34:02+02:00] await-and-seed: poll: project aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee is 'active', not 'done' — not firing
      [2026-08-18T04:34:03+02:00] await-and-seed: poll: project aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee is 'active', not 'done' — not firing
      [2026-08-18T04:34:04+02:00] await-and-seed: FIRE: project aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee reached status=done
      [2026-08-18T04:34:04+02:00] await-and-seed: POST http://127.0.0.1:44149/api/projects/8c591d6c-5642-4fd6-97ef-e0aeb2dbf2b4/status {"status":"active"}
      [2026-08-18T04:34:04+02:00] await-and-seed:   reactivated: HTTP 200
      [2026-08-18T04:34:04+02:00] await-and-seed: POST http://127.0.0.1:44149/api/projects/8c591d6c-5642-4fd6-97ef-e0aeb2dbf2b4/tasks  <- payload-token.json
      [2026-08-18T04:34:04+02:00] await-and-seed:   SEEDED: HTTP 201 — {"task": {"id": "11111111-2222-4333-8444-555555555555"}}
      [2026-08-18T04:34:04+02:00] await-and-seed: done — exit 0
      --- end ---
      requests seen:
        GET /api/projects/aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee
        GET /api/projects/aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee
        GET /api/projects/aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee
        GET /api/projects/aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee
        POST /api/projects/8c591d6c-5642-4fd6-97ef-e0aeb2dbf2b4/status
        POST /api/projects/8c591d6c-5642-4fd6-97ef-e0aeb2dbf2b4/tasks
  ok   6.1 it exited 0                                          = 0
  ok   6.2 it refused 'active' at least once                    contains: is 'active', not 'done'
  ok   6.3 the FIRE line names status=done                      contains: reached status=done
  ok   6.4 the reactivation came first                          = POST /api/projects/8c591d6c-5642-4fd6-97ef-e0aeb2dbf2b4/status
  ok   6.5 exactly one task POST                                = 1
  ok   6.6 --substitute rendered the token in write_set         contains: after-aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee.md
  ok   6.7 no token survived into the POSTed body               no: DOD6_PROJECT_ID
  ok   6.8 it polled the project, not pm2                       = 0

CENSUS
  cases      declared 6   executed 6
  assertions declared 49   executed 49

check-await-seed.sh PASSED — 6/6 cases, 49/49 assertions.
```

*(End of the round-802 transcript. `[historical instrument]` — the subject
sha256 `efe79f2c…` and this check's `7b68fa82…` above are the round-802 files;
both moved at round 804. Nothing in it was edited.)*

**The round-804 run of the same check, after case 7 landed:**

```
BUILD IDENTITY OF THE CODE UNDER TEST
  worktree path    : /opt/ai-os/workspace/projects/8c591d6c-5642-4fd6-97ef-e0aeb2dbf2b4
  git branch       : project/8c591d6c
  subject sha256   : 9429971eea0c1aa77afe346f58988c0405b57410e373a282b55b5630c6e2a8d0   <-- authoritative
  this check sha256: cd3b654ce2d6c1e74396b6b6d19c470a1d6d3fd57bdfff17e045321e8e2db8c8

CASE 7 — the manager chat REFUSES the message: a WARNING, not 'notified'
      [.. TIMEOUT after 3s (ceiling 3s) — waiting for: forge-executor to restart
          past restart_time=9 and come back online. SEEDING NOTHING.
      [.. WARNING: the manager chat REJECTED the message — HTTP 409: {"error": "run cancelled - use POST /api/runs/:id/resume-chat to reopen it"}
      [..          POSTed to http://127.0.0.1:36177/api/runs/bfd1283a-.../message. Nobody was told; the message above is only in this log.
  ok   7.1 the exit code is UNCHANGED — still 2               = 2
  ok   7.2 the timeout reason is still reported                 contains: TIMEOUT after
  ok   7.6 the message really WAS POSTed (probe reached)        = 1
  ok   7.3 it does NOT claim the chat was notified              no: manager chat notified
  ok   7.4 a WARNING names the refusal and its code             contains: REJECTED the message — HTTP 409
  ok   7.5 the WARNING quotes the API's body verbatim           contains: run cancelled - use POST /api/runs/:id/resume-chat
  ok   7.7 nothing was seeded despite the refusal               = 0

CENSUS
  cases      declared 7   executed 7
  assertions declared 56   executed 56

check-await-seed.sh PASSED — 7/7 cases, 56/56 assertions.
```

**The `git HEAD` and `subject dirty` lines the harness prints are deliberately
omitted from this paste, and the reason is not tidiness.** This transcript lives
*inside* the commit that carries the code it measures, so any commit sha written
here is either the previous commit's — which is not what ran — or a sha that does
not exist yet. A header pasted into the commit it names cannot be correct, and an
amend changes it again. The **content-addressed** `sha256` lines have no such
problem: they identify the bytes, not the history, and they are what the harness
itself marks `<-- authoritative`. Verify by content, which is reproducible at any
HEAD:

```
$ sha256sum scripts/deploy/await-and-seed.sh scripts/checks/check-await-seed.sh
9429971eea0c1aa77afe346f58988c0405b57410e373a282b55b5630c6e2a8d0  scripts/deploy/await-and-seed.sh
cd3b654ce2d6c1e74396b6b6d19c470a1d6d3fd57bdfff17e045321e8e2db8c8  scripts/checks/check-await-seed.sh
```

If those two values match your checkout, this is the run you are reading, whatever
`git HEAD` says. (`00-vision.md` §7 rule 3 — "a sha naming the worktree rather
than the build" is how a stale harness certified itself once already; a sha naming
a commit that cannot exist yet is the same error one step further on.)

### 4.1 Proving the census can fail

The gate that matters most here is the one round 223 found missing in
`check-plan-store.ts`: a table that declares a case it never reaches reads as
coverage. At round 802 the mutation was `CASES_DECLARED` raised to **7** without
adding a seventh case — the transcript below. **Round 804 added a real seventh
case, so 7 is now the honest value and the equivalent mutation today is 8.** Re-run
at round 804 rather than asserted, because a red mutation whose re-run nobody
watched is the same claim it exists to replace:

```
$ sed 's/^CASES_DECLARED=7$/CASES_DECLARED=8/' check-await-seed.sh > <scratch copy>   # no eighth case added
$ bash <scratch copy>
CENSUS
  cases      declared 8   executed 7
  assertions declared 56   executed 56
check-await-seed.sh FAILED: 7 cases ran, 8 declared.
  fewer => a declared case never ran and this run certifies nothing.
  more  => a case was added without updating CASES_DECLARED.
exit=1
```

Note it fails **after** case 7 has already printed seven `ok` lines: the census
is what turns a screen full of passes into a verdict. The round-802 transcript
below is left as it was — regenerating it would destroy the measurement it
records, and the two runs agree.

```
check-await-seed.sh — engine-task-graph phase 8D (await-and-seed.sh)

BUILD IDENTITY OF THE CODE UNDER TEST
  worktree path    : /opt/ai-os/workspace/projects/8c591d6c-5642-4fd6-97ef-e0aeb2dbf2b4
  git HEAD         : 2f835d1cfd9bed3af6f7f449d1558263e798f81b
  git branch       : project/8c591d6c
  subject          : /opt/ai-os/workspace/projects/8c591d6c-5642-4fd6-97ef-e0aeb2dbf2b4/scripts/deploy/await-and-seed.sh
  subject sha256   : efe79f2c53686e63ee565c1a1721621d7e44f3439d2fae397b90227455dfb869   <-- authoritative
  subject dirty    : ?? scripts/deploy/await-and-seed.sh
  this check sha256: 7b68fa8243301c0e1572fe27f3c4209914921aa55bd36f5db334120288bbda4d
  bash             : 5.2.21(1)-release
  python3          : Python 3.12.3
  curl             : curl 8.5.0 (x86_64-pc-linux-gnu) libcurl/8.5.0 OpenSSL/3.0.13 zlib/1.3 brotli/1.1.0 zstd/1.5.5 libidn2/2.3.7 libpsl/0.21.2 (+libidn2/2.3.7) libssh/0.10.6/openssl/zlib nghttp2/1.59.0 librtmp/2.3 OpenLDAP/2.6.10

recorder listening on http://127.0.0.1:58373 (pid 1453840), request log /tmp/tmp.fdWF14OeWe/requests.jsonl

CASE 1 — the restart counter is UNMOVED: the watcher POSTs NOTHING
      --- case1.log ---
      [2026-08-18T04:34:57+02:00] await-and-seed: provenance head=2f835d1 self-sha256=efe79f2c53686e63ee565c1a1721621d7e44f3439d2fae397b90227455dfb869 mode=executor-restart payload=/tmp/tmp.fdWF14OeWe/payload-ok.json launched=2026-08-18T04:34:57+02:00 baseline=[restart_time=7 pm_uptime=900000 status=online service=forge-executor] poll=1s timeout=600s api=http://127.0.0.1:58373
      [2026-08-18T04:34:57+02:00] await-and-seed: substitutions: none
      [2026-08-18T04:34:57+02:00] await-and-seed: waiting for: forge-executor to restart past restart_time=7 and come back online
      [2026-08-18T04:34:57+02:00] await-and-seed: poll: restart_time=7 has not passed the baseline 7 (status=online) — not firing
      [2026-08-18T04:34:58+02:00] await-and-seed: poll: restart_time=7 has not passed the baseline 7 (status=online) — not firing
      [2026-08-18T04:34:59+02:00] await-and-seed: poll: restart_time=7 has not passed the baseline 7 (status=online) — not firing
      [2026-08-18T04:35:01+02:00] await-and-seed: poll: restart_time=7 has not passed the baseline 7 (status=online) — not firing
      [2026-08-18T04:35:02+02:00] await-and-seed: poll: restart_time=7 has not passed the baseline 7 (status=online) — not firing
      --- end ---
  ok   1.1 no request of any kind reached the API               = 0
  ok   1.2 the pm2 shim was really called (probe reached)       >= 3 (got 6)
  ok   1.3 the transcript shows repeated refusals               >= 3 (got 5)
  ok   1.4 it names the baseline it compared against            contains: has not passed the baseline 7
  ok   1.5 the provenance line came first                       contains: provenance head=
  ok   1.6 the provenance line carries its own sha256           contains: self-sha256=efe79f2c53686e63ee565c1a1721621d7e44f3439d2fae397b90227455dfb869
  ok   1.7 the provenance line carries the baseline             contains: baseline=[restart_time=7 pm_uptime=900000 status=online
  ok   1.8 it was still running when we killed it               != 0

CASE 2 — the counter MOVES and status is online: exactly one seeding, status POST first
      --- case2.log ---
      [2026-08-18T04:35:02+02:00] await-and-seed: provenance head=2f835d1 self-sha256=efe79f2c53686e63ee565c1a1721621d7e44f3439d2fae397b90227455dfb869 mode=executor-restart payload=/tmp/tmp.fdWF14OeWe/payload-ok.json launched=2026-08-18T04:35:02+02:00 baseline=[restart_time=7 pm_uptime=900000 status=online service=forge-executor] poll=1s timeout=600s api=http://127.0.0.1:58373
      [2026-08-18T04:35:02+02:00] await-and-seed: substitutions: none
      [2026-08-18T04:35:02+02:00] await-and-seed: waiting for: forge-executor to restart past restart_time=7 and come back online
      [2026-08-18T04:35:02+02:00] await-and-seed: poll: restart_time=7 has not passed the baseline 7 (status=online) — not firing
      [2026-08-18T04:35:03+02:00] await-and-seed: poll: restart_time=7 has not passed the baseline 7 (status=online) — not firing
      [2026-08-18T04:35:05+02:00] await-and-seed: FIRE: forge-executor restarted — restart_time 7 -> 8, status=online, pm_uptime=1787020509000 (launch 1787020502000)
      [2026-08-18T04:35:05+02:00] await-and-seed: POST http://127.0.0.1:58373/api/projects/8c591d6c-5642-4fd6-97ef-e0aeb2dbf2b4/status {"status":"active"}
      [2026-08-18T04:35:05+02:00] await-and-seed:   reactivated: HTTP 200
      [2026-08-18T04:35:05+02:00] await-and-seed: POST http://127.0.0.1:58373/api/projects/8c591d6c-5642-4fd6-97ef-e0aeb2dbf2b4/tasks  <- payload-ok.json
      [2026-08-18T04:35:05+02:00] await-and-seed:   SEEDED: HTTP 201 — {"task": {"id": "11111111-2222-4333-8444-555555555555"}}
      [2026-08-18T04:35:05+02:00] await-and-seed: done — exit 0
      --- end ---
      requests seen:
        POST /api/projects/8c591d6c-5642-4fd6-97ef-e0aeb2dbf2b4/status
        POST /api/projects/8c591d6c-5642-4fd6-97ef-e0aeb2dbf2b4/tasks
  ok   2.1 the watcher exited 0                                 = 0
  ok   2.2 exactly two requests were made                       = 2
  ok   2.3 the FIRST request is the reactivation                = POST /api/projects/8c591d6c-5642-4fd6-97ef-e0aeb2dbf2b4/status
  ok   2.4 the SECOND request is the task POST                  = POST /api/projects/8c591d6c-5642-4fd6-97ef-e0aeb2dbf2b4/tasks
  ok   2.5 exactly one task POST, never two                     = 1
  ok   2.6 the reactivation body is status:active               contains: {"status":"active"}
  ok   2.7 the task body is the rendered payload                contains: check-await-seed fake task
  ok   2.8 it refused the baseline BEFORE the flip              contains: has not passed the baseline 7
  ok   2.9 the FIRE line names the transition                   contains: restart_time 7 -> 8
  ok   2.10 it logged the 201                                   contains: SEEDED: HTTP 201
  ok   2.11 no manager-chat message was needed                  no: /message

CASE 3 — a 409 on the task POST is SUCCESS and is logged as such
      --- case3.log ---
      [2026-08-18T04:35:05+02:00] await-and-seed: provenance head=2f835d1 self-sha256=efe79f2c53686e63ee565c1a1721621d7e44f3439d2fae397b90227455dfb869 mode=executor-restart payload=/tmp/tmp.fdWF14OeWe/payload-ok.json launched=2026-08-18T04:35:05+02:00 baseline=[restart_time=8 pm_uptime=900000 status=online service=forge-executor] poll=1s timeout=600s api=http://127.0.0.1:58373
      [2026-08-18T04:35:05+02:00] await-and-seed: substitutions: none
      [2026-08-18T04:35:05+02:00] await-and-seed: waiting for: forge-executor to restart past restart_time=8 and come back online
      [2026-08-18T04:35:05+02:00] await-and-seed: poll: restart_time=8 has not passed the baseline 8 (status=online) — not firing
      [2026-08-18T04:35:06+02:00] await-and-seed: poll: restart_time=8 has not passed the baseline 8 (status=online) — not firing
      [2026-08-18T04:35:07+02:00] await-and-seed: FIRE: forge-executor restarted — restart_time 8 -> 9, status=online, pm_uptime=1787020512000 (launch 1787020505000)
      [2026-08-18T04:35:07+02:00] await-and-seed: POST http://127.0.0.1:58373/api/projects/8c591d6c-5642-4fd6-97ef-e0aeb2dbf2b4/status {"status":"active"}
      [2026-08-18T04:35:07+02:00] await-and-seed:   reactivated: HTTP 200
      [2026-08-18T04:35:07+02:00] await-and-seed: POST http://127.0.0.1:58373/api/projects/8c591d6c-5642-4fd6-97ef-e0aeb2dbf2b4/tasks  <- payload-ok.json
      [2026-08-18T04:35:07+02:00] await-and-seed:   ALREADY SEEDED (409 treated as SUCCESS — identity (project, round, role, title) already exists, migration 0035): {"task": {"id": "11111111-2222-4333-8444-555555555555"}, "error": "duplicate task: this project already has a task with that round/role/title"}
      [2026-08-18T04:35:07+02:00] await-and-seed: done — exit 0
      --- end ---
  ok   3.1 a 409 exits 0 — it is a success                    = 0
  ok   3.2 the transcript calls it a SUCCESS                    contains: 409 treated as SUCCESS
  ok   3.3 it names the identity that already exists            contains: (project, round, role, title)
  ok   3.4 the API's duplicate message is quoted                contains: duplicate task
  ok   3.5 it still POSTed exactly once                         = 1

CASE 4 — an unsubstituted __TOKEN__ seeds NOTHING and exits non-zero
      --- case4.log ---
      [2026-08-18T04:35:07+02:00] await-and-seed: provenance head=2f835d1 self-sha256=efe79f2c53686e63ee565c1a1721621d7e44f3439d2fae397b90227455dfb869 mode=executor-restart payload=/tmp/tmp.fdWF14OeWe/payload-token.json launched=2026-08-18T04:35:07+02:00 baseline=[restart_time=9 pm_uptime=900000 status=online service=forge-executor] poll=1s timeout=600s api=http://127.0.0.1:58373
      [2026-08-18T04:35:07+02:00] await-and-seed: substitutions: none
      [2026-08-18T04:35:07+02:00] await-and-seed: HARD ERROR (at launch): the rendered payload still carries unsubstituted token(s): __DOD6_PROJECT_ID__ 
      [2026-08-18T04:35:07+02:00] await-and-seed:   payload      : /tmp/tmp.fdWF14OeWe/payload-token.json
      [2026-08-18T04:35:07+02:00] await-and-seed:   substitutions: none
      [2026-08-18T04:35:07+02:00] await-and-seed:   seeding NOTHING.
      [2026-08-18T04:35:07+02:00] await-and-seed: manager chat notified (HTTP 202)
      --- end ---
  ok   4.1 it exits non-zero                                    exit 1
  ok   4.2 the reason is the token guard, not a crash           = 1
  ok   4.3 the offending token is NAMED                         contains: __DOD6_PROJECT_ID__
  ok   4.4 it says it seeded nothing                            contains: seeding NOTHING
  ok   4.5 no reactivation POST                                 = 0
  ok   4.6 no task POST                                         = 0
  ok   4.7 exactly one manager-chat message                     = 1
  ok   4.8 the message names the payload                        contains: payload-token.json

CASE 5 — on TIMEOUT it seeds nothing, tells the manager, exits non-zero
      --- case5.log ---
      [2026-08-18T04:35:07+02:00] await-and-seed: provenance head=2f835d1 self-sha256=efe79f2c53686e63ee565c1a1721621d7e44f3439d2fae397b90227455dfb869 mode=executor-restart payload=/tmp/tmp.fdWF14OeWe/payload-ok.json launched=2026-08-18T04:35:07+02:00 baseline=[restart_time=9 pm_uptime=900000 status=online service=forge-executor] poll=1s timeout=3s api=http://127.0.0.1:58373
      [2026-08-18T04:35:07+02:00] await-and-seed: substitutions: none
      [2026-08-18T04:35:07+02:00] await-and-seed: waiting for: forge-executor to restart past restart_time=9 and come back online
      [2026-08-18T04:35:07+02:00] await-and-seed: poll: restart_time=9 has not passed the baseline 9 (status=online) — not firing
      [2026-08-18T04:35:08+02:00] await-and-seed: poll: restart_time=9 has not passed the baseline 9 (status=online) — not firing
      [2026-08-18T04:35:09+02:00] await-and-seed: poll: restart_time=9 has not passed the baseline 9 (status=online) — not firing
      [2026-08-18T04:35:10+02:00] await-and-seed: poll: restart_time=9 has not passed the baseline 9 (status=online) — not firing
      [2026-08-18T04:35:10+02:00] await-and-seed: TIMEOUT after 3s (ceiling 3s) — waiting for: forge-executor to restart past restart_time=9 and come back online. SEEDING NOTHING.
      [2026-08-18T04:35:10+02:00] await-and-seed: manager chat notified (HTTP 202)
      --- end ---
  ok   5.1 it exits non-zero                                    exit 2
  ok   5.2 and specifically with 2, the timeout code            = 2
  ok   5.3 the transcript says TIMEOUT                          contains: TIMEOUT after
  ok   5.4 it says it seeded nothing                            contains: SEEDING NOTHING
  ok   5.5 no reactivation POST                                 = 0
  ok   5.6 no task POST                                         = 0
  ok   5.7 exactly one manager-chat message                     = 1
  ok   5.8 the message says WHAT it was waiting for             contains: to restart past restart_time=9
  ok   5.9 the message says nothing was seeded                  contains: seeded NOTHING

CASE 6 — project-done mode fires on status=done and not before
      --- case6.log ---
      [2026-08-18T04:35:11+02:00] await-and-seed: provenance head=2f835d1 self-sha256=efe79f2c53686e63ee565c1a1721621d7e44f3439d2fae397b90227455dfb869 mode=project-done payload=/tmp/tmp.fdWF14OeWe/payload-token.json launched=2026-08-18T04:35:11+02:00 baseline=[project=aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee status=active] poll=1s timeout=600s api=http://127.0.0.1:58373
      [2026-08-18T04:35:11+02:00] await-and-seed: substitutions: __DOD6_PROJECT_ID__=aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee
      [2026-08-18T04:35:11+02:00] await-and-seed: waiting for: project aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee to reach status=done
      [2026-08-18T04:35:11+02:00] await-and-seed: poll: project aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee is 'active', not 'done' — not firing
      [2026-08-18T04:35:12+02:00] await-and-seed: poll: project aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee is 'active', not 'done' — not firing
      [2026-08-18T04:35:13+02:00] await-and-seed: FIRE: project aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee reached status=done
      [2026-08-18T04:35:13+02:00] await-and-seed: POST http://127.0.0.1:58373/api/projects/8c591d6c-5642-4fd6-97ef-e0aeb2dbf2b4/status {"status":"active"}
      [2026-08-18T04:35:13+02:00] await-and-seed:   reactivated: HTTP 200
      [2026-08-18T04:35:13+02:00] await-and-seed: POST http://127.0.0.1:58373/api/projects/8c591d6c-5642-4fd6-97ef-e0aeb2dbf2b4/tasks  <- payload-token.json
      [2026-08-18T04:35:13+02:00] await-and-seed:   SEEDED: HTTP 201 — {"task": {"id": "11111111-2222-4333-8444-555555555555"}}
      [2026-08-18T04:35:13+02:00] await-and-seed: done — exit 0
      --- end ---
      requests seen:
        GET /api/projects/aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee
        GET /api/projects/aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee
        GET /api/projects/aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee
        GET /api/projects/aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee
        POST /api/projects/8c591d6c-5642-4fd6-97ef-e0aeb2dbf2b4/status
        POST /api/projects/8c591d6c-5642-4fd6-97ef-e0aeb2dbf2b4/tasks
  ok   6.1 it exited 0                                          = 0
  ok   6.2 it refused 'active' at least once                    contains: is 'active', not 'done'
  ok   6.3 the FIRE line names status=done                      contains: reached status=done
  ok   6.4 the reactivation came first                          = POST /api/projects/8c591d6c-5642-4fd6-97ef-e0aeb2dbf2b4/status
  ok   6.5 exactly one task POST                                = 1
  ok   6.6 --substitute rendered the token in write_set         contains: after-aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee.md
  ok   6.7 no token survived into the POSTed body               no: DOD6_PROJECT_ID
  ok   6.8 it polled the project, not pm2                       = 0

CENSUS
  cases      declared 7   executed 6
  assertions declared 49   executed 49
check-await-seed.sh FAILED: 6 cases ran, 7 declared.
  fewer => a declared case never ran and this run certifies nothing.
  more  => a case was added without updating CASES_DECLARED.
NC4 exit=1
```

Note the shape: **zero FAIL lines, and it still exits 1.** That is the round-223
failure caught by construction.

---

## 5. `check-instrument-typecheck.sh` + `instrument-manifest.txt` — universal gate item 9 — **superseded by `docs/plan/scripts-checks-typecheck-gate/`, round 500**

> **SUPERSEDED — READ THIS FIRST.** Everything in §5 and §5.1 is the evidence
> record of the **round-802 gate**, and the transcripts below are left exactly
> as they were produced, because editing a record falsifies it. **What the gate
> does now:** it enumerates every `.ts`/`.tsx` under `scripts/checks/` by glob
> at run time (recursively, dotfiles included), compiles each one in its own
> `tsc` invocation through the checked-in profile
> `tsconfig.checks-instruments.json`, and reads `instrument-manifest.txt` only
> as a **waiver ledger** — printed above the verdict on every run, failing on a
> waived file that compiles clean. The manifest guard described below is
> retired: glob enumeration makes "did the author remember to list their file"
> unaskable. Measured at round 500: 42 subjects found, 42 compiled, exit 0.
> The current record is
> `docs/plan/scripts-checks-typecheck-gate/evidence/phase5-ledger.md`.

`scripts/checks/*.ts` is compiled by nothing. `tsx` strips types without checking
them, and the directory sits outside both projects' tsconfig `include` lists
(`forge-control/tsconfig.json` reads `"include": ["src/**/*.ts"]`). §3.1 item 1 —
the only typecheck any phase runs — never examines a single check script. This
is the third time the same hole has been found: phase 7's `measure-schedule.ts`
(§3.2 "Added round 212"), phase 6's `forge-control-web/` half ("Added round
223"), and phase 6B's whole-directory measurement. Found three times, fixed zero.

**Why the gate is manifest-scoped and not directory-wide, measured at round
800.** 6B's invocation over all 25 `scripts/checks/*.ts` in ONE invocation does
not pass and cannot be made to pass by this project: compiled together they pull
`forge-control-web/app` into the program (DOM-lib failures in `useAutogrow.ts`
and `tokens.ts`), and three other projects' scripts are independently red —
`check-orientation.ts` (3 type errors plus a `--jsx` failure), `serve-sse-808.ts`
(implicit `any`s), `check-chat-rich.tsx`. An unsatisfiable gate teaches reviewers
that disclose-and-proceed is normal, which is the habit standing rule 2 exists to
break. So the gate covers what this branch OWNS — the six files this branch
added or modified, all of which pass — and it **grows by construction**: the
manifest guard fails, by name, if any `scripts/checks/*.ts` in this branch's
diff is missing from the manifest. Closing the rest of the directory is the DoD-6
measurement project's job, and that project's goal says so in as many words.

The compile options are the ones 6B measured, verbatim, one file per invocation:

```
cd forge-control-web && npx tsc --noEmit --strict --target ES2022 --module esnext \
  --moduleResolution bundler --allowImportingTsExtensions --types node --lib ES2022 \
  ../scripts/checks/<file>.ts
```

FULL TRANSCRIPT:

```
check-instrument-typecheck.sh — universal gate item 9 (03-quality.md §3.1)

PROVENANCE
  worktree path    : /opt/ai-os/workspace/projects/8c591d6c-5642-4fd6-97ef-e0aeb2dbf2b4
  git HEAD         : 3dd39b4939cfbefec76f2ef184a601676b796d76
  git branch       : project/8c591d6c
  this check sha256: e89df70329bb6a39a199bbdce4eb7f8ffce70cf34cd0acedc2c1e88b6d959b6a
  manifest         : /opt/ai-os/workspace/projects/8c591d6c-5642-4fd6-97ef-e0aeb2dbf2b4/scripts/checks/instrument-manifest.txt
  manifest sha256  : 96c57c1365c7257c8b493087c8389cfbe49a0f399e620e89cef4cd15cd068d32
  manifest entries : 6
  tsc              : Version 5.7.2
  node             : v22.22.2
  options          : --noEmit --strict --target ES2022 --module esnext --moduleResolution bundler --allowImportingTsExtensions --types node --lib ES2022

TYPECHECK — one invocation per entry
  PASS scripts/checks/check-close-gate.ts                   exit 0, 0 errors
  PASS scripts/checks/check-fix-chain-graph.ts              exit 0, 0 errors
  PASS scripts/checks/check-plan-api.ts                     exit 0, 0 errors
  PASS scripts/checks/check-plan-store.ts                   exit 0, 0 errors
  PASS scripts/checks/check-project-metadata.ts             exit 0, 0 errors
  PASS scripts/checks/check-task-api.ts                     exit 0, 0 errors

MANIFEST GUARD — every scripts/checks/*.ts this branch touched must be manifested
  merge-base       : 4f6cd3178f1f515a50a70a16628468e77c6a55f7
  touched by this branch:
    scripts/checks/check-close-gate.ts
    scripts/checks/check-fix-chain-graph.ts
    scripts/checks/check-plan-api.ts
    scripts/checks/check-plan-store.ts
    scripts/checks/check-project-metadata.ts
    scripts/checks/check-task-api.ts
  ok: every touched instrument is manifested

CENSUS
  entries declared 6   entries compiled 6   failures 0   unmanifested 0

check-instrument-typecheck.sh PASSED — 6/6 entries compiled clean, manifest complete.
```

One deliberate narrowing, recorded because it is a judgement and not a
transcription: the manifest guard's diff uses `--diff-filter=ACMR`, which
EXCLUDES deletions. A file this branch DELETED cannot be compiled, and demanding
it be manifested would be an unsatisfiable gate of exactly the kind standing rule
2 forbids. Renames are reported at their new path, which is the path that must be
manifested.

### 5.1 PROVING IT CAN FAIL — three ways — **superseded by `docs/plan/scripts-checks-typecheck-gate/`, round 500**

> **SUPERSEDED.** These three breakages were applied to the **round-802** gate
> and their transcripts are its record, kept intact. Control (c) below breaks
> the *manifest guard*, which no longer exists. **The gate is proven able to
> fail today by four negative controls** — a broken type in a covered
> instrument, a **new** file in the directory listed nowhere (the control the
> round-802 design could only pass via its guard), no
> `forge-control-web/node_modules`, and an uncovered `.mts` — transcribed in
> `docs/plan/scripts-checks-typecheck-gate/evidence/negative-controls.md`, plus
> three ledger controls in `.../evidence/phase5-ledger.md`.

A typecheck that has only ever been observed passing is the exact defect it
exists to catch. All three breakages were applied, run, and reverted; the working
tree was confirmed clean afterwards.

**(a) Break a manifested file's types on purpose.** Three lines appended to
`scripts/checks/check-close-gate.ts`, then removed:

```
check-instrument-typecheck.sh — universal gate item 9 (03-quality.md §3.1)

PROVENANCE
  worktree path    : /opt/ai-os/workspace/projects/8c591d6c-5642-4fd6-97ef-e0aeb2dbf2b4
  git HEAD         : 2f835d1cfd9bed3af6f7f449d1558263e798f81b
  git branch       : project/8c591d6c
  this check sha256: e89df70329bb6a39a199bbdce4eb7f8ffce70cf34cd0acedc2c1e88b6d959b6a
  manifest         : /opt/ai-os/workspace/projects/8c591d6c-5642-4fd6-97ef-e0aeb2dbf2b4/scripts/checks/instrument-manifest.txt
  manifest sha256  : 96c57c1365c7257c8b493087c8389cfbe49a0f399e620e89cef4cd15cd068d32
  manifest entries : 6
  tsc              : Version 5.7.2
  node             : v22.22.2
  options          : --noEmit --strict --target ES2022 --module esnext --moduleResolution bundler --allowImportingTsExtensions --types node --lib ES2022

TYPECHECK — one invocation per entry
  FAIL scripts/checks/check-close-gate.ts                   exit 2
         ../scripts/checks/check-close-gate.ts(571,7): error TS2322: Type 'string' is not assignable to type 'number'.
  PASS scripts/checks/check-fix-chain-graph.ts              exit 0, 0 errors
  PASS scripts/checks/check-plan-api.ts                     exit 0, 0 errors
  PASS scripts/checks/check-plan-store.ts                   exit 0, 0 errors
  PASS scripts/checks/check-project-metadata.ts             exit 0, 0 errors
  PASS scripts/checks/check-task-api.ts                     exit 0, 0 errors

MANIFEST GUARD — every scripts/checks/*.ts this branch touched must be manifested
  merge-base       : 4f6cd3178f1f515a50a70a16628468e77c6a55f7
  touched by this branch:
    scripts/checks/check-close-gate.ts
    scripts/checks/check-fix-chain-graph.ts
    scripts/checks/check-plan-api.ts
    scripts/checks/check-plan-store.ts
    scripts/checks/check-project-metadata.ts
    scripts/checks/check-task-api.ts
  ok: every touched instrument is manifested

CENSUS
  entries declared 6   entries compiled 6   failures 1   unmanifested 0

check-instrument-typecheck.sh FAILED — 1 type failure(s), 0 unmanifested file(s).
NC1 exit=1
```

**(b) Remove an entry from the manifest while the file is still in the branch
diff.** `scripts/checks/check-task-api.ts` dropped from the manifest — note that
the five remaining entries all compile CLEAN and it still exits 1:

```
check-instrument-typecheck.sh — universal gate item 9 (03-quality.md §3.1)

PROVENANCE
  worktree path    : /opt/ai-os/workspace/projects/8c591d6c-5642-4fd6-97ef-e0aeb2dbf2b4
  git HEAD         : 2f835d1cfd9bed3af6f7f449d1558263e798f81b
  git branch       : project/8c591d6c
  this check sha256: e89df70329bb6a39a199bbdce4eb7f8ffce70cf34cd0acedc2c1e88b6d959b6a
  manifest         : /opt/ai-os/workspace/projects/8c591d6c-5642-4fd6-97ef-e0aeb2dbf2b4/scripts/checks/instrument-manifest.txt
  manifest sha256  : 9e094d8f48aa411d5106ce212bde4589cb3e14f3e9ca8d2546ab5378624552ac
  manifest entries : 5
  tsc              : Version 5.7.2
  node             : v22.22.2
  options          : --noEmit --strict --target ES2022 --module esnext --moduleResolution bundler --allowImportingTsExtensions --types node --lib ES2022

TYPECHECK — one invocation per entry
  PASS scripts/checks/check-close-gate.ts                   exit 0, 0 errors
  PASS scripts/checks/check-fix-chain-graph.ts              exit 0, 0 errors
  PASS scripts/checks/check-plan-api.ts                     exit 0, 0 errors
  PASS scripts/checks/check-plan-store.ts                   exit 0, 0 errors
  PASS scripts/checks/check-project-metadata.ts             exit 0, 0 errors

MANIFEST GUARD — every scripts/checks/*.ts this branch touched must be manifested
  merge-base       : 4f6cd3178f1f515a50a70a16628468e77c6a55f7
  touched by this branch:
    scripts/checks/check-close-gate.ts
    scripts/checks/check-fix-chain-graph.ts
    scripts/checks/check-plan-api.ts
    scripts/checks/check-plan-store.ts
    scripts/checks/check-project-metadata.ts
    scripts/checks/check-task-api.ts
  FAIL scripts/checks/check-task-api.ts                     MODIFIED BY THIS BRANCH AND ABSENT FROM THE MANIFEST
  add the 1 file(s) named above to /opt/ai-os/workspace/projects/8c591d6c-5642-4fd6-97ef-e0aeb2dbf2b4/scripts/checks/instrument-manifest.txt and make them compile.

CENSUS
  entries declared 5   entries compiled 5   failures 0   unmanifested 1

check-instrument-typecheck.sh FAILED — 0 type failure(s), 1 unmanifested file(s).
NC2 exit=1
```

**(c) Point it at a tree with no `forge-control-web/node_modules`.** A throwaway
directory holding only the script and the manifest:

```
REFUSING TO RUN: forge-control-web/node_modules is absent (or carries no tsc).

  looked in: <throwaway-tree>/forge-control-web/node_modules/.bin/tsc

This worktree ships WITHOUT forge-control-web/node_modules — it is gitignored —
so a fresh worktree has no compiler and this gate would otherwise answer
"tsc: not found", which is how a gate gets disclosed and ignored. Fix it with
exactly this line (measured at round 221: ~1s offline from the local pnpm
store), then re-run:

  cd forge-control-web && NODE_ENV=development pnpm install --frozen-lockfile --prefer-offline

Keep --frozen-lockfile: it is what guarantees NFU8's
`git diff main -- forge-control-web/package.json` stays empty.
NC3 exit=1
```

The refusal names the exact install line rather than answering `tsc: not found`,
which is the form of failure that gets disclosed and ignored (the precedent is
§3.2's phase-6 precondition block).

---

## 6. Self-verification

```
$ bash -n scripts/deploy/await-and-seed.sh              # OK
$ bash -n scripts/checks/check-await-seed.sh            # OK
$ bash -n scripts/checks/check-instrument-typecheck.sh  # OK
$ command -v shellcheck                                 # /usr/bin/shellcheck — 0.9.0 (round 804; see §6.1)
$ bash scripts/checks/check-await-seed.sh               # exit 0 — 7/7 cases, 56/56 assertions (round 804)
$ bash scripts/checks/check-instrument-typecheck.sh     # exit 0 — 6/6 entries clean, manifest complete
```

Payload validation — JSON parses and each carries the six required keys:

```
payload-report.json    json OK  six-keys=yes  round=817  role=builder  tier=standard depends_on=[]  brief=6705 chars
payload-review.json    json OK  six-keys=yes  round=819  role=reviewer tier=standard depends_on=['__REPORT_TASK_ID__']  brief=6586 chars
payload-verify.json    json OK  six-keys=yes  round=815  role=builder  tier=standard depends_on=[]  brief=12043 chars
```

R66 sweep — `03-quality.md` §4 declares an expected hit count of exactly 4, and a
fifth from a new script would be a finding. It is still 4, and none of the three
new shell files contains the string in any form:

```
$ grep -rn "pm2 restart forge-executor" . --include='*.ts' --include='*.sh'
./forge-control/src/lib/project-tick.test.ts:216:      /NEVER[^.]*pm2 restart forge-executor/,
./forge-control/src/lib/project-tick.test.ts:217:      "DEPLOY_GUIDE missing a NEVER-worded prohibition on pm2 restart forge-executor",
./forge-control/src/lib/project-tick.ts:410:    `- NEVER run \`pm2 restart forge-executor\`. That kills every run in flight, including your own. ` +
./forge-control/src/lib/project-tick.ts:571:  `- NEVER \`pm2 restart forge-executor\`. Not to deploy, not to test, not "just this once".\n` +
hits: 4  (03-quality.md §4 expects exactly 4)

$ grep -c "pm2 restart" <the three new shell files>
scripts/deploy/await-and-seed.sh:0
scripts/checks/check-await-seed.sh:0
scripts/checks/check-instrument-typecheck.sh:0
```

**Disclosed:** `scripts/deploy/payload-review.json` contains the string once, in
the reviewer's own instruction to RUN that grep — the same construction
`03-quality.md` §4 uses for itself. It is a `.json` file, outside the sweep's
declared `*.ts`/`*.sh` scope, so the count above is unaffected. Named here so the
round-803 reviewer does not have to rediscover it.

**RETIRED at round 804 — the disclosure below is superseded, and its gate was
written in the same commit (standing rule 4).** What stood here read:

> **Finding — `shellcheck` is not installed on this box.** Three new shell
> scripts shipped this round with `bash -n` as their only static check. `bash -n`
> catches syntax, not quoting or unset-variable hazards. […] the gap is recorded
> rather than glossed.

It is no longer true: `shellcheck 0.9.0` is at `/usr/bin/shellcheck`. A recorded
gap that nobody re-measures becomes a licence, so round 804 executed the run the
finding deferred, fixed what it caught, and turned it into `03-quality.md` §3.1
**universal gate item 10** — because without the gate this reappears the moment
an eighth script is added. See §6.1.

### 6.1 The shellcheck run the finding deferred — executed, round 804

**The file list is derived, never typed.** Same expression as §3.1 item 9's
branch-ownership set, for the same measured reason: `merge-base...HEAD` returns
`main`'s files too after round 801's merge commit.

```
$ git rev-parse --short HEAD
674d860

$ git log --no-merges --name-only --pretty=format: main..HEAD -- '*.sh' | sort -u | sed '/^$/d'
scripts/checks/check-await-seed.sh
scripts/checks/check-instrument-typecheck.sh
scripts/checks/check-migration-0040.sh
scripts/checks/check-r69-straddle.sh
scripts/checks/check-scheduler-sql.sh
scripts/checks/check-workstream-e2e.sh
scripts/deploy/await-and-seed.sh
                                        7 files
```

**Before the fix** — six clean, one not:

```
$ shellcheck -S error scripts/deploy/await-and-seed.sh
In scripts/deploy/await-and-seed.sh line 312:
  # shellcheck disable=SC2086 — PM2_CMD is a command line by contract (see the
                              ^-- SC1125 (error): Invalid key=value pair? Ignoring the rest of this directive starting here.
exit=1
```

**After** — all seven, one invocation:

```
$ shellcheck -S error $(git log --no-merges --name-only --pretty=format: main..HEAD -- '*.sh' | sort -u)
exit=0
```

**Why `-S error` and not the default severity — the gate has to be passable
(standing rule 2).** At full severity the same seven emit SC2154 (`rc` in the
ERR traps, assigned by `rc=$?` in a scope shellcheck cannot see), SC2015 (the
`A && pass || fail` assert helpers, where `pass` cannot fail so the idiom is
sound) and SC1010, across scripts **five of the six check scripts already
shipped**. A default-severity gate would therefore be red on arrival and be
disclosed-and-ignored, which is the exact habit `00-vision.md` §7 rule 2 exists
to stop. `-S error` is the severity at which the whole set is clean today, so it
is the severity that can be *enforced* today.

**What the gate does NOT cover, stated so nobody mistakes its silence for
proof.** SC2086 is an *info*, so `-S error` can never emit it — which is why
round 804 finding 1's question ("was the suppression load-bearing?") had to be
settled by direct measurement rather than by this gate. Measured at 0.9.0:
SC2086 fires for a variable in ARGUMENT position (`cat $X`) and does **not**
fire for one in COMMAND-NAME position (`{ $CMD …; } | …`), which is
`read_pm2()`'s shape — so the suppression suppressed nothing, and was dropped
rather than kept bare. Reasoning inline at the site.

**The gate can fail, and it did — twice, on this branch's own code.** Once on
`await-and-seed.sh`'s SC1125 (the transcript above), and once on the reworded
comment that replaced it (SC1073/SC1072, below). Neither was hypothetical and
neither was injected; a gate first observed failing on real code is worth more
than a red mutation.

**It also cannot certify an EMPTY sweep** — the property a derived file list
most needs. Measured:

```
$ shellcheck -S error          # i.e. what happens if the git expression returns nothing
No files specified.
[18 further lines of usage text elided — marked, round 806]
exit=3
```

Non-zero. A broken file-list expression fails the gate instead of reporting a
clean tree.

**A trap this run walked into itself, recorded because it will catch the next
author.** Any comment line *beginning* with the hash, a space and the linter's
name is parsed as a directive wherever it sits — prose included. Writing the
explanatory paragraph at `read_pm2()` the obvious way produced SC1073/SC1072 on
the very branch that was removing an SC1125. Caught by re-running the gate after
the fix, which is the argument for the gate in one sentence.

**A scope correction, round 806, recorded here because a commit message cannot be
amended without rewriting shared history.** Round 804's commit (`9147dff`) says
"zero suppression directives remain anywhere on the branch". *Anywhere* is one
file too wide: `scripts/import-scraper-places.acceptance.sh` still carries a
well-formed `SC1091` suppression. That file lives on `main` and this branch never
touches it, so it is outside the gate's derived list and the gate is not wrong —
only the sentence is. **The accurate claim is: zero suppression directives remain
in the seven `*.sh` this branch adds or modifies**, which is the set item 10
lints and the only set this branch can speak for. Round 805's reviewer raised
this and declined to block on it; agreed on both counts, and it is written down
here rather than left to a reader who reads the commit message and not this
paragraph.

```
$ SH_ALL=$(git log --no-merges --name-only --pretty=format: main..HEAD -- '*.sh' | sort -u)
$ grep -l "shellcheck disable" $(for f in $SH_ALL; do [ -f "$f" ] && printf '%s\n' "$f"; done)
                                # no output, exit 1 — none of the seven carries one
$ grep -rn "shellcheck disable" scripts/ | grep -v "^docs/"
scripts/import-scraper-places.acceptance.sh:31:  # shellcheck disable=SC1091
                                # the one survivor, on main, untouched by this branch
                                # (the two leading spaces are the file's own indent)
```

---

### 6.2 The delete case — why item 10's file list is filtered (round 806)

Round 805's reviewer noted, without blocking on it, that item 10's derived list
"will error rather than pass if a future branch *deletes* a `.sh`". Measured, it
is worse than an error and narrower than it sounds, so it is amended in
`03-quality.md` §3.1 item 10 and §4 — where it is enforced, in this commit,
standing rule 2.

Scratch repo, four cases. `main` holds `doomed.sh`; the branch adds `added.sh`
and deletes `doomed.sh`. The two files are made textually distinct on purpose:
a first attempt used near-identical one-liners, git scored them as a **rename**
(`R050 doomed.sh added.sh`), only the destination appeared in `--name-only`, and
the measurement quietly tested nothing. **The instrument lied before the code
did**, which is why the `name-status` line is pasted below — it is what proves
the case under test is the case intended.

**A — the delete reaches the linter (unfiltered, i.e. the form before this
commit).**

```
$ git show --name-status --pretty=format:"" HEAD
A	added.sh
D	doomed.sh
$ git log --no-merges --name-only --pretty=format: main..HEAD -- "*.sh" | sort -u
added.sh
doomed.sh
$ shellcheck -S error $(git log --no-merges --name-only --pretty=format: main..HEAD -- "*.sh" | sort -u)
doomed.sh: doomed.sh: openBinaryFile: does not exist (No such file or directory)
exit=2
```

`added.sh` is clean, and the run still cannot exit 0.

**C — the same tree with an SC1125 planted in `added.sh`, which is the case that
tells us what the exit code is worth.**

```
--- unfiltered ---
doomed.sh: doomed.sh: openBinaryFile: does not exist (No such file or directory)

In added.sh line 2:
# shellcheck disable=SC2086 — an em-dash, as in the real defect
                            ^-- SC1125 (error): Invalid key=value pair? Ignoring the rest of this directive starting here.

For more information:
  https://www.shellcheck.net/wiki/SC1125 -- Invalid key=value pair? Ignoring ...
exit=2
```

So the survivors **are** still linted — the finding is printed. What breaks is
the verdict: **exit 2 in case A with a clean tree, exit 2 in case C with a
broken one.** A gate whose pass and fail are the same number has stopped
measuring, and the branch cannot reach 0 whatever it does.

**B and C — filtered (the form this commit installs). The absent path is named,
not silently dropped; the surviving file is linted; the exit code discriminates
again.**

```
--- B, clean survivor ---
deleted on this branch, not linted: doomed.sh
exit=0

--- C, SC1125 planted ---
deleted on this branch, not linted: doomed.sh

In added.sh line 2:
# shellcheck disable=SC2086 — an em-dash, as in the real defect
                            ^-- SC1125 (error): Invalid key=value pair? Ignoring the rest of this directive starting here.

For more information:
  https://www.shellcheck.net/wiki/SC1125 -- Invalid key=value pair? Ignoring ...
exit=1
```

**D — the filter must not turn the empty-sweep property off.** A branch that
deletes every `*.sh` it touched leaves the filtered list empty, and an empty
list is the one thing this gate must refuse to certify (§6.1 above).

```
$ SH_ALL=added.sh doomed.sh          # both now absent from the tree
$ shellcheck -S error $(for f in $SH_ALL; do [ -f "$f" ] && printf '%s\n' "$f"; done)
No files specified.
[18 further lines of usage text elided — the marker is the exit code]
exit=3
```

Non-zero, as before. The filter removes a crash and no teeth.

**And the real branch, unchanged by the amendment:** 7 files derived, 7 on disk,
no `deleted on this branch` note, `exit=0` — the same verdict round 805 recorded
for the unfiltered form, which is the point. Fed the pre-fix `await-and-seed.sh`
(`674d860`, sha256 `efe79f2c5368` against HEAD's `9429971eea0c`) through the
filtered pipeline alongside one absent path, it still reports SC1125 at line 312
and exits 1.

---

## 7. The three rendered briefs, pasted in full for the round-803 reviewer

The payloads are the deliverable; these are their `brief` fields verbatim, so the
reviewer can judge the prose without reconstructing it from JSON escapes.

### `payload-verify.json` — role `builder`, round 815, tier `standard`

`write_set`: `["docs/plan/engine-task-graph/evidence/phase8-verify.md"]`  ·  `depends_on`: `[]`  ·  title: *Phase 8G: live verification after the restart*

```text
You are the explicitly-briefed POST-RESTART VERIFICATION TASK (R67,
`03-quality.md` §2.3). You verify against LIVE — the live checkout at
/opt/forge-ai-os, the live `content_forge` database, the live API on
127.0.0.1:7700, and the live pm2 fleet. THAT AUTHORITY IS YOURS AND NO OTHER
TASK'S: every other task in this project is worktree-only, and you are the one
place where §2.3's exception applies. You did not run before the restart; a
detached watcher (`scripts/deploy/await-and-seed.sh executor-restart`) POSTed
you only once `forge-executor`'s `restart_time` had increased past the baseline
it captured, so the engine you are testing is the NEW one.

**NEVER run the prohibited executor restart command (R66).** Not to fix
anything, not "just this once". If the executor is wrong, you report it.

Paste EVERY command and its complete output into
`docs/plan/engine-task-graph/evidence/phase8-verify.md`. A claim without its
transcript is not evidence.

--- 1. THE RESTART LANDED ---
`pm2 jlist` (parse with python3; jq is not guaranteed) shows `forge-executor`
`status: online`, a `restart_time` greater than it was before the deploy, and a
`pm_uptime` later than the deploy task's own finish. Quote the three fields.
Then quote the matching lines out of BOTH logs — `/tmp/safe-restart.log` and
`/var/log/forge-safe-restart.log` — showing the idle wait ("waiting for idle to
restart") and the restart itself ("idle confirmed", "restarted forge-executor —
status=online"). Two logs because safe-restart.sh writes its own to
/var/log and the detached launch redirects stdout to /tmp; if they disagree,
say so.

--- 2. THE LIVE CHECKOUT IS CLEAN ---
`git -C /opt/forge-ai-os status --porcelain` — EMPTY. Any output at all is a
finding, with the dirty files named verbatim (`03-quality.md` §3.1 item 3).
`git -C /opt/forge-ai-os log --oneline -1` must name the merge landed by the
round-811 deploy task. Paste both.

--- 3. THE SCHEMA IS ON THE LIVE DATABASE ---
Confirm BY NAME, never by assuming a file ran, that `project_tasks` carries all
four columns — `depends_on`, `workstream`, `write_set`, and `graph_frozen`
(R71) — and both indexes, `project_tasks_depends_on_gin` and
`project_tasks_workstream_idx`:

    psql -U postgres -d content_forge -c "\d project_tasks"

Then R71's consistency pair. Run both and paste both; THE SECOND MUST BE 0:

    SELECT graph_frozen, count(*) FROM project_tasks GROUP BY 1;
    SELECT count(*) FROM project_tasks WHERE graph_frozen <> (depends_on IS NOT NULL);

A non-zero second number means the backfill and the sentinel disagree on the
live data, which is the one condition under which the replay proof stops
describing production. Report it as a blocking finding, do not repair it
yourself, and say what you think caused it.

--- 4. THE OTHER MIGRATIONS THAT RODE ALONG ---
Round 811 applied `0040_task_graph.sql` and, alongside it, `0040_usage_hourly.sql`
and `0041_ui_dismissals.sql`. Confirm BY NAME that `usage_hourly`, `app_settings`
and `ui_dismissals` exist — `\dt usage_hourly app_settings ui_dismissals` — never
by assuming the file ran. Then confirm the two routes that read them answer 200
and not 500:

    curl -s -o /dev/null -w '%{http_code}\n' http://127.0.0.1:7700/api/chat/bfd1283a-b71b-4f35-b577-7d09aad803f2/team
    curl -s -o /dev/null -w '%{http_code}\n' 'http://127.0.0.1:7700/api/usage/series'

A 500 here is a deploy defect that the schema check above would not have caught,
because a missing table is invisible until something selects from it.

--- 5. R14 IS IN THE DEPLOYED TREE, NOT ONLY IN THE WORKTREE ---
Confirm BY SYMBOL, reading
`/opt/forge-ai-os/forge-control/src/db/projects.ts`, that `retryTask()` refuses
a row whose `depends_on` is corrupt with the reason `dependencies_corrupt`, and
that `force` does NOT override that refusal (the cap refusal
`attempts_exhausted` is the one `force` opens). Quote the guard. State the
finding explicitly in your report either way.

WHY THIS ONE MATTERS MORE THAN IT LOOKS: `/opt/ai-os/scripts/fleet-watchdog.sh`
runs on cron every 10 minutes and calls `POST /api/projects/:id/unwedge` on
every blocked project, and `unwedgeProject()` reaches `retryTask()`. This path
WILL be exercised unattended, at 04:00, with nobody reading the output. If the
refusal is NOT present in the deployed tree, say plainly that the watchdog must
be disabled until it is, and post that to the manager chat as a blocker rather
than burying it in the evidence file.

--- 6. THE CYCLE 400, HONESTLY ---
READ R25 AND R26 FIRST AND THEN REPORT WHAT IS ACTUALLY TRUE. R26's belt comment
documents the insert-time cycle as UNREACHABLE BY CONSTRUCTION: a row that does
not exist yet cannot be named in any other row's `depends_on`, so a POST cannot
close a cycle. DO NOT CLAIM TO HAVE INSERTED A CYCLE. The honest live probes are
the two 400s that ARE reachable, each of which must NAME the offending id:

  a) a `depends_on` naming an id that exists nowhere — expect 400, the dangling
     id named in the body;
  b) a `depends_on` naming a real task id belonging to a DIFFERENT project —
     expect 400, that id named in the body.

Paste both request bodies and both response bodies. Then state, in one
paragraph: a true cycle is unreachable at insert, this is why, and the detector
is nonetheless kept because `depends_on` is writable by an operator with psql
and because a future bulk-insert path would reopen the door — a detector
documented as unreachable is a detector nobody deletes by accident.

--- 7. THE TWO LIVE OBSERVATIONS DoD-1 AND DoD-2 OWE ---
These are OBSERVATIONS, not assertions. Create the DoD-6 project first (item 8),
then watch it.

  a) A GRAPH-SCHEDULED TASK PROMOTED WITHOUT ITS ROUND DRAINING. Record the SQL
     you used and its output with timestamps. The shape that proves it: a row of
     the new project in `ready` or `running` whose `round` is STRICTLY GREATER
     than the `round` of a row of the same project that is not yet `done`. For
     example:

       SELECT id, round, role, status, created_at, started_at
         FROM project_tasks WHERE project_id = '<NEW_ID>' ORDER BY round, created_at;

     and the pair-wise statement that names the two rows. Under the old rule
     that row could not exist.
  b) TWO WORKSTREAM WORKTREES ON DISK: `ls -la /opt/ai-os/workspace/projects/<NEW_ID>*`
     showing sibling directories, `git -C <each> rev-parse --abbrev-ref HEAD`
     showing branches `project/<NEW_ID>/<workstream>`, and
     `git -C <main worktree> status --porcelain` EMPTY (R34).

IF EITHER HAS NOT OCCURRED WITHIN 45 MINUTES OF THE FAN-OUT, SAY SO PLAINLY AND
HAND IT TO THE REPORT TASK. Do not wait in a loop, do not extend your own run,
and do not assert what you did not see. An unobserved item written up as
observed is worse than an open one.

--- 8. CREATE THE DoD-6 MEASUREMENT PROJECT AND LAUNCH THE SECOND WATCHER ---
FIRST, CHECK FOR A MANAGER MESSAGE. Read the manager chat before you POST:

    curl -s http://127.0.0.1:7700/api/runs/bfd1283a-b71b-4f35-b577-7d09aad803f2/comms

If Konrad has named a different goal for the measurement project, HIS OVERRIDES
the default below — use his, and say in your evidence file that you did and
quote the message. Otherwise take the default; the operator has already ruled on
it and you do not need to re-litigate it. (The ruling, so you do not: this goal
is real work rather than a synthetic errand, it is naturally parallel across ~25
disjoint files which is exactly the shape DoD-6 must exercise, and it touches no
executor-loaded code so it cannot brick the thing that runs it. SEED NOTHING
BEYOND IT — Konrad is cost-sensitive right now.)

    curl -sX POST http://127.0.0.1:7700/api/projects \
      -H 'content-type: application/json' \
      -d '{"repo":"ai-os","mode":"goal","architect_tier":"standard","goal":"<THE GOAL BELOW>"}'

THE GOAL, VERBATIM:
"Bring every script under scripts/checks/ under a typecheck gate and fix what it finds. tsx strips types without checking them and scripts/checks/ sits outside both tsconfig include lists, so the fleet's verification instruments are the least-verified code in the repo. Measured 2026-08-18: compiled one file per invocation, six scripts pass and check-orientation.ts, serve-sse-808.ts and check-chat-rich.tsx are red. Fix each red script, extend scripts/checks/instrument-manifest.txt to cover the whole directory, and prove the gate goes red when a file's types are broken."

Record the new project id. Then RECORD WHAT THE NEW PLANNER PROMPT ACTUALLY
PRODUCED, because the operator has ruled that this measurement must be
falsifiable: as soon as the architect and planner have fanned out, report
(i) the maximum concurrency actually reached, (ii) the count of tasks with a
NON-EMPTY `depends_on`, and (iii) how many DISTINCT `workstream` values
appeared. A project that comes out one task wide is a FAILED DoD-6 and must be
reported as one. DO NOT REPORT "THE PROMPT WORKED" FROM THE ABSENCE OF AN ERROR.

Then launch the second watcher — DETACHED, and DO NOT WAIT FOR IT:

    NEW_ID=<the id you just recorded>
    TOK="$(printf '__%s__' DOD6_PROJECT_ID)"
    setsid nohup /opt/forge-ai-os/scripts/deploy/await-and-seed.sh project-done "$NEW_ID" \
      /opt/forge-ai-os/scripts/deploy/payload-report.json --substitute "$TOK=$NEW_ID" \
      >> /tmp/forge-phase8-seed.log 2>&1 &

WHY `$TOK` AND NOT THE TOKEN TYPED OUT: `await-and-seed.sh` HARD-REFUSES any
payload that still carries a `__…__` token when it renders it, which is what
stops it seeding a task whose `write_set` names a placeholder. That guard cannot
tell a token meant for substitution from one merely quoted inside a brief — and
it must not try, because "it looked like documentation" is exactly how a
placeholder reaches production. So this brief, which lives INSIDE a payload,
builds the token at runtime instead of spelling it. Copy the two lines as they
stand; they are correct bash and they expand to exactly the intended flag.

Confirm the watcher is alive (`pgrep -af await-and-seed`) and then LEAVE IT.
Never poll it, never tail its log to completion.

--- 9. WRITE IT UP ---
Write `docs/plan/engine-task-graph/evidence/phase8-verify.md` in your worktree,
commit it with a message naming this phase and round, and report your findings —
especially any blocker from items 3, 4, 5 or 7 — to the manager chat. If item 7
is open, say which half and hand it to the round-817 report task by name.

=== STANDING RULES — binding on this task (00-vision.md §7) ===
1. CITE BY SYMBOL OR REQUIREMENT ID, never a bare `file.ts:170-188`. If a line
   number genuinely helps, pin it to a git SHA written beside it. A pin you
   cannot resolve is a FINDING you report, not a footnote you quietly
   reinterpret.
2. WRITE GATES THAT CAN BE PASSED. If you find an unsatisfiable gate, amend it
   WHERE IT IS ENFORCED, in the same commit, with the reasoning inline. A gate
   that can only be disclosed teaches that disclose-and-proceed is normal.
3. INSTRUMENTS LIE BEFORE CODE DOES. Before you assert a pass, ask what would
   have made your instrument report a pass WRONGLY, name it, and show it is
   impossible here. A harness must expose its own build identity; a sweep whose
   probes miss must exit non-zero rather than certify itself.
4. RETIRE A REQUIREMENT AND ITS GATE CLAUSE TOGETHER, in one commit, explicitly.
5. EVERY BUILDER BRIEF NAMES THE FILES IT WILL WRITE. Your write_set is declared
   on this task. An undeclared write is a finding under `03-quality.md` §3.1
   item 4. If you must write outside it, disclose it at the site AND record it in
   `04-phases.md` §10 in the same commit — the rule is disclose, not abstain.

MANAGER COMMS. Report findings, blockers and decisions to the manager chat:
  curl -sX POST http://127.0.0.1:7700/api/runs/bfd1283a-b71b-4f35-b577-7d09aad803f2/message \
    -H 'content-type: application/json' \
    -d '{"text":"<what you found>","from":"worker","sender_run_id":"'"$FORGE_RUN_UUID"'"}'
Findings, not narration. One report that matters beats five status pings.
```

### `payload-report.json` — role `builder`, round 817, tier `standard`

`write_set`: `["docs/plan/engine-task-graph/evidence/after-__DOD6_PROJECT_ID__.md"]`  ·  `depends_on`: `[]`  ·  title: *Phase 8H: the number, or the honest absence of one*

```text
DoD-6 and R68 — THE NUMBER, OR THE HONEST ABSENCE OF ONE.

The DoD-6 measurement project `__DOD6_PROJECT_ID__` has finished; that is why
you exist. A detached watcher (`await-and-seed.sh project-done`) saw it reach
`status: done` and POSTed you. You now run the COMMITTED instrument against it
and report what it says — whatever it says.

--- 1. RUN THE INSTRUMENT ---

    cd /opt/forge-ai-os/forge-control && ./node_modules/.bin/tsx \
      ../scripts/measure-schedule.ts full --project __DOD6_PROJECT_ID__

Paste the output in full, and paste the instrument's OWN HEADER FIRST — identity
before any number (R60). If the header is missing or the run degrades to a
smaller table, that is R61's failure mode and a finding, not a smaller result.

--- 2. COMMIT `docs/plan/engine-task-graph/evidence/after-__DOD6_PROJECT_ID__.md` ---
It carries, in this order:
  a) the instrument's header — SHA, schema version, project id, row counts —
     BEFORE any number (R60);
  b) THE SAME TABLE SHAPE AS `00-vision.md` §2: rounds, tasks per round, run
     count, mean run duration, wall clock. Same shape, so the two documents can
     be read side by side without a reader re-deriving the mapping;
  c) S1, S2 AND S3 AS NUMBERS;
  d) a comparison against PART 2 of `evidence/baseline-8ea0cc08.md` and against
     `00-vision.md` §4's thresholds: S1 >= 3.5, S2 <= 0.45, S3 0 by construction
     and REPORTED ANYWAY to prove it. Name each threshold, the measured value,
     and pass/fail.

--- 3. STATE WHICH PLANNER PROMPT PLANNED THE MEASURED PROJECT ---
Explicitly, in the document, with evidence: was `__DOD6_PROJECT_ID__` planned by
the NEW prompt (R47–R53, phase 5 — declares `depends_on`, `workstream` and
`write_set`, writes no round numbers) or by the legacy one? This is the
operator's constraint and it is load-bearing: an after-measurement taken on a
legacy single-workstream project would report a REGRESSION that is an artifact
of measuring the wrong thing — the same failure shape as the S3 closure trap
that round 214 caught. Prove it from the data: the count of tasks with a
non-empty `depends_on`, the count of DISTINCT `workstream` values, and the
maximum concurrency actually reached. A project that came out one task wide is a
FAILED DoD-6 and you report it as one. Do not report "the prompt worked" from
the absence of an error.

--- 4. IF THE NUMBERS ARE WORSE, SAY SO PLAINLY AND NAME THE CAUSE ---
A measurement that only ever confirms is not an instrument. A regression
reported plainly is a PASS for the instrument and a finding for the engine, and
those are different things. Candidate causes worth checking before you attribute
one: model latency rather than scheduling; a project too small for concurrency
to have anywhere to go; a planner that produced a chain; contention serialising
a workstream that should have split.

--- 5. ONE INSTRUMENT, BEFORE AND AFTER (R62) ---

    python3 docs/plan/engine-task-graph/check-instrument-identity.py

Run it and paste it. The before-measurement and the after-measurement must name
ONE instrument. If it exits non-zero, the fix is to re-run the affected headers
under the current bytes IN THE SAME COMMIT, per `03-quality.md` §3.1 item 7 —
not to edit a SHA by hand.

--- 6. CLOSE OR RESTATE ITEM 7 OF THE VERIFICATION TASK ---
Round 815's task (`evidence/phase8-verify.md`) owed two live OBSERVATIONS: a
graph-scheduled task promoting without its round draining, and two workstream
worktrees on disk. Read that file. If either was left open, close it here
against `__DOD6_PROJECT_ID__` — which by now has a full task history and, if it
fanned out, worktrees that existed — or state plainly that it REMAINS OPEN and
why. Do not close it by assertion.

--- 7. POST THE FINAL GATING REVIEWER ---
It cannot be a pending row seeded earlier: it must depend on YOUR task id, which
did not exist until the watcher POSTed you. Substitute your own id and POST:

    MY_TASK_ID=<your own project_tasks.id>
    TOK="$(printf '__%s__' REPORT_TASK_ID)"
    curl -sX POST http://127.0.0.1:7700/api/projects/8c591d6c-5642-4fd6-97ef-e0aeb2dbf2b4/tasks \
      -H 'content-type: application/json' \
      --data-binary @<(sed "s/$TOK/$MY_TASK_ID/g" /opt/forge-ai-os/scripts/deploy/payload-review.json)

A 201 is success and a 409 is also success (migration 0035's identity
`(project, round, role, title)` — the reviewer already exists and you have its
original id). Any other code is a blocker: report it to the manager chat
immediately, because nothing else will seed that reviewer.

WHY `$TOK` AND NOT THE TOKEN TYPED OUT: this brief lives inside
`payload-report.json`, and `await-and-seed.sh` HARD-REFUSES to POST any payload
still carrying a `__…__` token — the guard that stops it seeding a task whose
`write_set` names a placeholder. It cannot distinguish a token quoted in prose
from one awaiting substitution, and it must not try. So the token is built at
runtime. Copy the three lines as they stand; they are correct bash.

--- 8. REPORT ---
Report the headline numbers and any regression to the manager chat. Findings,
not narration.

=== STANDING RULES — binding on this task (00-vision.md §7) ===
1. CITE BY SYMBOL OR REQUIREMENT ID, never a bare `file.ts:170-188`. If a line
   number genuinely helps, pin it to a git SHA written beside it. A pin you
   cannot resolve is a FINDING you report, not a footnote you quietly
   reinterpret.
2. WRITE GATES THAT CAN BE PASSED. If you find an unsatisfiable gate, amend it
   WHERE IT IS ENFORCED, in the same commit, with the reasoning inline. A gate
   that can only be disclosed teaches that disclose-and-proceed is normal.
3. INSTRUMENTS LIE BEFORE CODE DOES. Before you assert a pass, ask what would
   have made your instrument report a pass WRONGLY, name it, and show it is
   impossible here. A harness must expose its own build identity; a sweep whose
   probes miss must exit non-zero rather than certify itself.
4. RETIRE A REQUIREMENT AND ITS GATE CLAUSE TOGETHER, in one commit, explicitly.
5. EVERY BUILDER BRIEF NAMES THE FILES IT WILL WRITE. Your write_set is declared
   on this task. An undeclared write is a finding under `03-quality.md` §3.1
   item 4. If you must write outside it, disclose it at the site AND record it in
   `04-phases.md` §10 in the same commit — the rule is disclose, not abstain.

MANAGER COMMS. Report findings, blockers and decisions to the manager chat:
  curl -sX POST http://127.0.0.1:7700/api/runs/bfd1283a-b71b-4f35-b577-7d09aad803f2/message \
    -H 'content-type: application/json' \
    -d '{"text":"<what you found>","from":"worker","sender_run_id":"'"$FORGE_RUN_UUID"'"}'
Findings, not narration. One report that matters beats five status pings.
```

### `payload-review.json` — role `reviewer`, round 819, tier `standard` — **the on-disk payload was amended in round 500; the paste below is unchanged**

> **AMENDED ON DISK, NOT HERE.** The paste that follows records what was
> RENDERED into the round-819 reviewer's instructions, and it is left verbatim.
> The item-9 paragraph of `scripts/deploy/payload-review.json` was rewritten in
> round 500 by `docs/plan/scripts-checks-typecheck-gate/` (a live brief that
> still told a future reviewer to expect manifest-scoped coverage is an A5.1
> breach, not a record). The replacement reads: *"it compiles EVERY
> `.ts`/`.tsx` under `scripts/checks/`, enumerated BY GLOB at run time, each in
> ITS OWN tsc invocation, through the checked-in profile
> `tsconfig.checks-instruments.json`; `instrument-manifest.txt` is a WAIVER
> LEDGER, not an inclusion list, and the manifest guard is retired."*

`write_set`: `[]`  ·  `depends_on`: `["__REPORT_TASK_ID__"]`  ·  title: *Phase 8 gating review: the deploy, the verification and the number*

```text
You are PHASE 8'S POST-DEPLOY GATING REVIEWER and the LAST TASK OF THIS
PROJECT. Everything this project claimed is now either true on a live box or it
is not, and you are the only reader left who can tell the difference.

--- 1. THE UNIVERSAL GATE, IN FULL (`03-quality.md` §3.1) ---
Run every line and PASTE EVERY OUTPUT:

    cd forge-control && pnpm typecheck && pnpm test
    git -C /opt/forge-ai-os status --porcelain
    git log --oneline "$(git merge-base main HEAD)"..HEAD --name-only
    python3 docs/plan/engine-task-graph/check-corpus-map.py
    python3 docs/plan/engine-task-graph/check-instrument-identity.py
    python3 scripts/checks/check-r20-census.py
    bash scripts/checks/check-instrument-typecheck.sh
    grep -rn "pm2 restart forge-executor" . --include='*.ts' --include='*.sh'
    grep -rn "consecutive rounds" forge-control/

`git -C /opt/forge-ai-os status --porcelain`: ANY output is BY ITSELF a
NEEDS_FIXES finding, with the dirty files named verbatim. Paste its emptiness if
it is empty — an unpasted check is an unrun check.

The R66 grep: expect EXACTLY FOUR hits and READ EVERY ONE (`03-quality.md` §4).
R66 permits the string only inside a sentence forbidding it. A fifth hit, or any
hit in an executable position, is a finding. Two of the four live in
`project-tick.ts`'s shipped deploy guidance and two in `project-tick.test.ts`
asserting that guidance still carries the prohibition; say which four you found.

`check-instrument-typecheck.sh` is universal-gate item 9, added this phase: it
compiles each entry of `scripts/checks/instrument-manifest.txt` in ITS OWN tsc
invocation and fails if any file this branch touched under `scripts/checks/*.ts`
is missing from the manifest. Do not accept its green run on faith — the
evidence file `evidence/phase8-tooling.md` records three ways it was watched
going RED, and reproducing one of them is cheap.

Then items 4, 5 and 6 of §3.1 in your own words: the write-set audit (every
builder task's commits vs its declared `write_set`), the citation audit (every
`file.ts:NN` resolved against a recorded SHA or reported), and the
silent-fallback audit (every `catch`, `?? default`, `|| fallback` this phase
added, and why each is not a swallowed error).

--- 2. THIS PHASE'S BLOCK (`03-quality.md` §3.2, Phase 8) ---
  a) THE E-3 ORDERING. The baseline read at step 2b happened BEFORE step 3
     applied migration 0040. CHECK THE ORDER IN `evidence/phase8-deploy.md`, not
     the intent, not the narrative. The order is the gate.
  b) THE `closure-shaped-rows=0` HEADER LINE must be present in the pasted
     baseline output. A non-zero count means the read happened after the
     migration whatever the prose says.
  c) READ THE S3 LINE BY ITS COUNTS, not by its adjective:
       - `NOT COMPUTABLE (131 legacy rows, 0 closure-shaped rows)` is the PASS.
         The read happened before the migration and the refusal names the legacy
         sentinel.
       - `legacy-rows=0` together with closure-shaped rows is a FINDING: the
         backfill had already run and the detector caught a late read.
       - ANY S3 NUMBER AT ALL FOR 8ea0cc08 is the WORST outcome and a finding
         whatever the narrative claims, because the only shape that produces one
         is the backfilled closure computing tautologically to 0.
  d) `grep -c "write_set" forge-control/src/lib/project-tick.ts` > 0 — R31 must
     not have reached production ahead of R47–R53.

--- 3. JUDGE THE AFTER-MEASUREMENT HONESTLY ---
Read `evidence/after-<the DoD-6 project id>.md`. A REGRESSION REPORTED PLAINLY IS
A PASS FOR THE INSTRUMENT AND A FINDING FOR THE ENGINE, and they are different
things — do not collapse them into one verdict. Check specifically that the
report states WHICH PLANNER PROMPT planned the measured project, and that it
reports the fan-out shape: max concurrency reached, the count of tasks with a
non-empty `depends_on`, and the number of distinct workstreams. A one-task-wide
project is a FAILED DoD-6 however good its wall clock looks, and a report that
infers "the prompt worked" from the absence of an error has not measured
anything.

--- 4. ANSWER §4'S THREE QUESTIONS BEFORE YOU WRITE A VERDICT ---
  1. What would have made MY instruments report a pass WRONGLY? Name at least
     two mechanisms and show each is impossible here.
  2. Which gate in `03-quality.md` did I find UNSATISFIABLE, and did I amend it
     WHERE IT IS ENFORCED in the same commit?
  3. Every citation I made: symbol name or requirement id? Any line number
     pinned to a SHA?

--- 5. PUSH, THEN CLOSE ---
On `VERDICT: PASS` and an origin remote, run
`scripts/git-sync-branch.sh <worktree-dir>`. PLAIN PUSH ONLY — never `--force`,
never `--force-with-lease`; this branch is shared. A push failure is reported
VERBATIM and NEVER changes the verdict.

Close with exactly one line, the LAST verdict declaration in your message:
`VERDICT: PASS` or `VERDICT: NEEDS_FIXES` followed by a concrete numbered list.

=== STANDING RULES — binding on this task (00-vision.md §7) ===
1. CITE BY SYMBOL OR REQUIREMENT ID, never a bare `file.ts:170-188`. If a line
   number genuinely helps, pin it to a git SHA written beside it. A pin you
   cannot resolve is a FINDING you report, not a footnote you quietly
   reinterpret.
2. WRITE GATES THAT CAN BE PASSED. If you find an unsatisfiable gate, amend it
   WHERE IT IS ENFORCED, in the same commit, with the reasoning inline. A gate
   that can only be disclosed teaches that disclose-and-proceed is normal.
3. INSTRUMENTS LIE BEFORE CODE DOES. Before you assert a pass, ask what would
   have made your instrument report a pass WRONGLY, name it, and show it is
   impossible here. A harness must expose its own build identity; a sweep whose
   probes miss must exit non-zero rather than certify itself.
4. RETIRE A REQUIREMENT AND ITS GATE CLAUSE TOGETHER, in one commit, explicitly.
5. EVERY BUILDER BRIEF NAMES THE FILES IT WILL WRITE. Your write_set is declared
   on this task. An undeclared write is a finding under `03-quality.md` §3.1
   item 4. If you must write outside it, disclose it at the site AND record it in
   `04-phases.md` §10 in the same commit — the rule is disclose, not abstain.

MANAGER COMMS. Report findings, blockers and decisions to the manager chat:
  curl -sX POST http://127.0.0.1:7700/api/runs/bfd1283a-b71b-4f35-b577-7d09aad803f2/message \
    -H 'content-type: application/json' \
    -d '{"text":"<what you found>","from":"worker","sender_run_id":"'"$FORGE_RUN_UUID"'"}'
Findings, not narration. One report that matters beats five status pings.
```


---

## 8. What is left, and for whom

- **8C owns `04-phases.md` §10** this round and declares all eight files above;
  this task did not edit that table, per its brief.
- **The deploy task (round 811)** launches the first watcher after the merge and
  the migration, detached, and ENDS:
  `setsid nohup /opt/forge-ai-os/scripts/deploy/await-and-seed.sh executor-restart /opt/forge-ai-os/scripts/deploy/payload-verify.json >> /tmp/forge-phase8-seed.log 2>&1 &`
  It must not poll it and must not tail its log to completion.
- **8C's §3.1 clause** must name `check-instrument-typecheck.sh` as item 9; this
  task wrote the script it runs, not the clause.
- The DoD-6 goal is the operator's default — bring `scripts/checks/` under a
  typecheck gate and fix what it finds — and `payload-verify.json` instructs the
  verification task to check the manager chat for an override before POSTing it.
