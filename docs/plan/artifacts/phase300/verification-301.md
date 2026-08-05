# Round 301 — verification transcript

Everything below was run in the worktree at `project/8ea0cc08` @ `cf87d9a`.
Zero files under `forge-control/src` were touched (`git status` at the end).

## 1. Compiler gates

```
$ cd forge-control && npx tsc --noEmit
forge-control tsc: CLEAN

$ cd forge-control-web && npx tsc --noEmit
forge-control-web tsc: CLEAN

$ cd forge-control && npx tsc --noEmit --target ES2022 --module ESNext \
    --moduleResolution bundler --lib ES2022 --strict --skipLibCheck \
    --allowImportingTsExtensions --isolatedModules --types node \
    ../scripts/checks/serve-v3-7798.ts
harness tsc: CLEAN

$ bash -n scripts/checks/api-diff.sh; bash -n docs/.../baseline/capture.sh
shellcheck-lite (bash -n): CLEAN
```

## 2. Harness — all three routers local, everything else proxied

Booting normally proves the routers answer, but not that they answered
*locally* — with production up, a proxied response looks identical. So the
harness was booted a second time with the upstream pointed at a **dead port**
(`FORGE_CONTROL_URL=http://127.0.0.1:9`). Now "local" and "proxy" are
distinguishable: local mounts must still return 200, everything else must 502.

```
[7798] worktree /api/agents live on http://127.0.0.1:7798
[7798] worktree /api/chat live on http://127.0.0.1:7798
[7798] worktree /api/projects live on http://127.0.0.1:7798
[7798] GET /api/chat/:id/events is proxied on purpose (buffered writer cannot stream SSE)
[7798] everything else proxies (buffered, no SSE) to http://127.0.0.1:9

=== upstream deliberately DEAD (:9) — local mounts must still answer 200 ===
/api/agents              HTTP 200
/api/chat?limit=1        HTTP 200
/api/projects/managers   HTTP 200
/api/projects            HTTP 200

=== unmounted / excepted paths must FAIL through the dead proxy ===
/api/health                          HTTP 502  {"error":"upstream proxy failed","upstream":"http://127.0.0.1:9"}
/api/secrets                         HTTP 502  {"error":"upstream proxy failed","upstream":"http://127.0.0.1:9"}
/api/projectsomething                HTTP 502  {"error":"upstream proxy failed","upstream":"http://127.0.0.1:9"}
/api/chatter                         HTTP 502  {"error":"upstream proxy failed","upstream":"http://127.0.0.1:9"}
/api/chat/bfd1283a…/events           HTTP 502  {"error":"upstream proxy failed","upstream":"http://127.0.0.1:9"}

=== control: a real chat id UNDER the mount is served locally ===
/api/chat/bfd1283a…                  HTTP 200
```

What each line proves:

- the three mounts are served by **worktree code**, not by :7700;
- `/api/projectsomething` and `/api/chatter` are **not** swallowed by the
  `/api/projects` and `/api/chat` prefixes — the exact-or-followed-by-slash
  match holds;
- `GET /api/chat/:id/events` takes the **proxy** path (the hard exception),
  while `/api/chat/:id` right next to it is local;
- `/api/health` and `/api/secrets` proxy.

Restored against the real upstream afterwards: `agents(local)=200 health(proxy)=200`.

`src/index.ts` is never imported — the harness mounts routers only, so no cron
tick, telegram long-poll, vault sync or probe loop is started a second time.

## 3. `api-diff.sh` — clean run

```
ok    agents — key set identical, normalized values byte-equal
ok    agents-project — key set identical, normalized values byte-equal
ok    agents-run — key set identical, normalized values byte-equal
ok    chat-list — key set identical, normalized values byte-equal
ok    chat-thread — key set identical, normalized values byte-equal
ok    projects — key set identical, normalized values byte-equal
ok    projects-managers — key set identical, normalized values byte-equal
ok    secrets — key set identical, normalized values byte-equal

api-diff.sh: PASS — 8 endpoints match the baseline
CLEAN EXIT=0
```

## 4. `api-diff.sh` — proven to FAIL on perturbation

### 4a. Settled row's frozen duration, +1 ms → VALUE layer

The single most important guarantee of phase 300 (time truth): a settled run's
`elapsed_ms` is history. One millisecond is enough to fail.

```
$ jq '(.agents[]|select(.id=="a59d2cf8…").elapsed_ms) |= (.+1)'
FAIL  agents — normalized VALUES differ
        -      "elapsed_ms": 91242,
        +      "elapsed_ms": 91243,
               "id": "a59d2cf8-e28d-4f01-a906-b460ecc1863f",
api-diff.sh: FAILED
EXIT=1
```

### 4b. Field renamed on a LIVE row → KEY SET layer

```
$ jq '.managers |= map(. + {spend_usd: .spent_usd} | del(.spent_usd))'
FAIL  projects-managers — KEY SET changed (a field was added, removed or renamed)
        -managers.[].spent_usd
        +managers.[].spend_usd
api-diff.sh: FAILED
EXIT=1
```

Worth recording: the **first** version of the normalizer used `. + {k: V}`,
which silently *recreated* the deleted `spent_usd` and reported only
`+spend_usd` — a half-blind result. It was rewritten to `blank()`, which
overwrites keys in place and only when present. Removals and renames are now
caught even on rows whose values are waived.

### 4c. Settled document, one value → VALUE layer

`chat-thread.json` is a settled run, so **no** normalization applies to it at all.

```
$ jq '.run.spent_usd = "99.99"'
FAIL  chat-thread — normalized VALUES differ
        -    "spent_usd": "49.92",
        +    "spent_usd": "99.99",
api-diff.sh: FAILED
EXIT=1
```

## 5. Negative control — the check is not vacuous

A gate that fails on everything is worthless. Every field the normalizer claims
to waive was moved to an absurd value — including forcing a live row to *settle*
— and the run must still pass:

```
$ jq '.now = "2099-01-01T00:00:00.000Z"
      | .summary.running = 999 | .summary.spent_usd_last_hour = 12345.67
      | .agents |= map(if .settled != true then
          (.elapsed_ms = 88888888 | .updated_at = "2099-01-01 00:00:00+00"
           | .current_activity = {"kind":"tampered"}
           | .usage_running = {"input_tokens":424242}
           | .status = "completed" | .settled = true) else . end)'

ok    agents — key set identical, normalized values byte-equal
api-diff.sh: PASS
EXIT=0
```

Row churn is reported loudly but is **not** a failure — a run starting or
finishing is the world moving, not a regression:

```
$ jq '.agents |= map(select(.id != "a33224e2…"))'     # drop a live row
DRIFT agents — rows in baseline, gone now: ["a33224e2-ad4d-44f0-ac6f-dfd9b18bc2ad"]
api-diff.sh: PASS
EXIT=0
```

A live run of the finished script, minutes after the baseline was taken, shows
the drift report doing its job on real churn — one run finished, one started,
two live rows swapped rank — while every settled row still compares byte-equal:

```
DRIFT agents — rows in baseline, gone now: ["8c625bb5-7c15-488b-af3c-3cec68d19d1b"]
DRIFT agents — rows new since baseline: ["888b2031-9e0f-4e2c-bf86-80b2ed13e6a4"]
DRIFT agents — row ORDER changed (2 of 59 common rows moved)
        a33224e2-ad4d-44f0-ac6f-dfd9b18bc2ad  0→1
        5f359463-2df7-4645-93e4-f371dd899c6c  1→0
ok    agents — key set identical, normalized values byte-equal
…
api-diff.sh: PASS — 8 endpoints match the baseline
EXIT=0
```

The order report prints only the rows that moved. The first version printed both
full id lists — a 60-element wall of text nobody would read, which for a report
whose whole job is to be read is a defect; fixed.

### Final state of the suite

Re-run against the finished script, all five at once:

| Fixture | Perturbation | Expected | Got |
|---|---|---|---|
| `/tmp/perturb` | settled row `elapsed_ms` +1 ms | FAIL | `FAIL agents — normalized VALUES differ`, exit 1 |
| `/tmp/perturb2` | live row field renamed | FAIL | `FAIL projects-managers — KEY SET changed`, exit 1 |
| `/tmp/perturb4` | settled document value | FAIL | `FAIL chat-thread — normalized VALUES differ`, exit 1 |
| `/tmp/perturb3` | every waived clock moved | PASS | `api-diff.sh: PASS`, exit 0 |
| `/tmp/perturb5` | live row dropped | PASS | `api-diff.sh: PASS`, exit 0 |

## 6. Worktree is NOT main — see `baseline/README.md`

The brief's premise that the worktree equals main for these routes is false;
measured and documented in `baseline/README.md` §"Correction". Summary: the
`/api/agents` family differs from main by six added row fields and two added
subagent fields (phases 1–2, undeployed, purely additive); the other five
endpoints are byte-identical to main. Round 302 is unaffected — its reference is
the pre-refactor state, which is this transcript. **The baseline must be
re-captured after the deploy-phase `merge main`.**

## 7. Scope

```
$ git status --short
?? docs/plan/artifacts/phase300/baseline/
?? scripts/checks/api-diff.sh
?? scripts/checks/serve-v3-7798.ts
```

No `forge-control/src` file was modified. `serve-agents-7798.ts` is untouched.
No pm2 restart. The live checkout `/opt/forge-ai-os` was read (`git rev-parse`)
but never written.
