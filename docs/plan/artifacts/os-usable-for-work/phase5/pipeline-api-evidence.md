# phase5/pipeline-api-evidence.md — GET /api/pipeline, measured

Round 1 of phase 5 (workstream `business`), task 2 of 4. R64–R68 on the server
side. Every block below is command output, pasted; the JSON blocks were
injected from the captured response files rather than retyped.

- Branch: `project/7851068b-business`
- Instrument: `phase5/serve-pipeline.ts` (task 1's harness) on `127.0.0.1:7841`,
  MODE A — **this worktree's** `routes/pipeline.ts` against the **live**
  `content_forge`. `forge-control/src/index.ts` was never booted.
- Connection strings: `/opt/ai-os/.secrets/forge-control.env`.
- **Read-only (R68).** Every statement is a `SELECT`; the only pm2 verb is
  `pm2 jlist`; the only redis verbs are `TYPE`, `LLEN`, `ZCARD` (and `AUTH`/
  `SELECT` when a URL carries credentials, which this one does not). No
  `INSERT`/`UPDATE`/`DELETE`, no `pm2 restart`. Self-audit at the bottom.

---

## What was built

| File | What |
|---|---|
| `forge-control/src/lib/pipeline-health.ts` | pure: `STALL_AFTER_HOURS`, `resolveStallHours`, `stallCutoffMs`, `classifyStall` (R64), `classifyPhaseState` (R65), `parsePm2Jlist` (R66) |
| `forge-control/src/lib/pipeline-health.test.ts` | 28 tests incl. **the flip test** and both boundary sides |
| `forge-control/src/lib/redis-probe.ts` | RESP2 over `node:net`, no new dependency (R67) |
| `forge-control/src/lib/redis-probe.test.ts` | 26 tests over captured byte strings |
| `forge-control/src/db/pipeline.ts` | stall per card, state per phase, **the two fake counts fixed**, `getWorkerHealth()` |
| `forge-control/src/routes/pipeline.ts` | same `GET /`, response gains `as_of`, `stall_threshold_hours`, `workers`, `queues` |
| `forge-control-web/app/api-business.ts` | NEW — this lane's client. `app/api.ts` untouched (02-architecture.md §0.3) |

---

## 1. Verification commands and their exit status

```
### CMD-1  dependencies (never a bare --frozen-lockfile: NODE_ENV=production
###        prunes tsx and typescript and still exits 0)
$ cd forge-control && pnpm install --frozen-lockfile --prod=false
Lockfile is up to date, resolution step is skipped
Already up to date
Done in 737ms using pnpm v9.15.9

$ ls node_modules/.bin/ | grep -E '^(tsc|tsx)$'
tsc
tsx

### CMD-2  typecheck
$ npx tsc --noEmit
(no output, exit 0)

### CMD-3  the full suite, not just the new files
$ pnpm test                       # tsx --test src/lib/*.test.ts
# tests 1347
# suites 250
# pass 1347
# fail 0

### CMD-4  the two new files alone
$ ./node_modules/.bin/tsx --test src/lib/pipeline-health.test.ts src/lib/redis-probe.test.ts
# tests 54
# pass 54
# fail 0

### CMD-5  the harness typechecks against the router it now imports
$ npx tsc --noEmit --target ES2022 --module ESNext --moduleResolution bundler \
    --lib ES2022 --strict --skipLibCheck --allowImportingTsExtensions \
    --isolatedModules --types node \
    ../docs/plan/artifacts/os-usable-for-work/phase5/serve-pipeline.ts
SERVE_TSC=OK

### CMD-6  the web package
$ cd forge-control-web && pnpm install --frozen-lockfile --prod=false && npx tsc --noEmit
Already up to date
WEB_TSC=OK
```

---

## 2. The tests are not inert — both classifiers were mutated and the tests bit

A passing test proves nothing until you have watched it fail. Each mutation was
applied to the worktree file, the suite was re-run, and the file was restored
from a pre-mutation copy with `sha256sum -c` confirming the restore.

```
### CMD-7  MUTATION A — a classifier that marks EVERYTHING stalled.
###        This is the exact defect the flip test exists to catch: against live
###        data (5 jobs, all stuck) an always-true classifier passes the
###        positive half and ships.
$ sed -i 's|    stalled: t < stallCutoffMs(now, thresholdHours),|    stalled: true,|' src/lib/pipeline-health.ts
$ ./node_modules/.bin/tsx --test src/lib/pipeline-health.test.ts
    not ok 2 - THE FLIP: a job updated NOW is NOT stalled
    not ok 3 - THE FLIP: an hour-old job is not stalled, a fortnight-old one is
    not ok 4 - the boundary is asserted BOTH ways, one minute either side
    not ok 5 - the boundary moves with the threshold
# tests 28
# pass 24
# fail 4
$ cp /tmp/p5-canary-pipeline-health.ts src/lib/pipeline-health.ts
$ sha256sum -c /tmp/p5-canary.sha
src/lib/pipeline-health.ts: OK

### CMD-8  MUTATION B — an absent redis key degrading to depth 0. The classic
###        shape of "a stuck pipeline looks calm".
$ sed -i 's|  if (cmd === null) return { set, key, redis_type: typeReply, depth: null };|  if (cmd === null) return { set, key, redis_type: typeReply, depth: 0 };|' src/lib/redis-probe.ts
$ ./node_modules/.bin/tsx --test src/lib/redis-probe.test.ts
    not ok 3 - an absent key is depth NULL, never 0
    not ok 4 - an uncountable type is absent too, and keeps its type name
# tests 26
# pass 24
# fail 2
$ cp /tmp/p5-canary-redis-probe.ts src/lib/redis-probe.ts
$ sha256sum -c /tmp/p5-canary-redis.sha
src/lib/redis-probe.ts: OK
```

**One finding from mutation A, folded into the test file rather than left for a
reviewer to trip over.** A job whose `status_updated_at` is *exactly* `now`
takes `classifyStall`'s zero-age early return (`ageMs <= 0`), so the literal
"a job updated NOW" assertion the brief names does **not**, on its own,
discriminate an always-stalled classifier — it passed under mutation A on the
first run. The test now asserts a one-second-old job in the same case, which
goes through the threshold comparison itself. That is why `not ok 2` appears in
CMD-7 above and did not in the first run.

---

## 3. LIVE: `GET /api/pipeline` against the real `content_forge`

```
### CMD-9
$ set -a; . /opt/ai-os/.secrets/forge-control.env; set +a
$ cd forge-control
$ SERVE_PIPELINE_PORT=7841 ./node_modules/.bin/tsx \
    ../docs/plan/artifacts/os-usable-for-work/phase5/serve-pipeline.ts &
[p5] worktree /api/pipeline live on http://127.0.0.1:7841 — mode LIVE (worktree code → content_forge)
[p5] everything else proxies (buffered, no SSE) to http://127.0.0.1:7700

$ curl -sS http://127.0.0.1:7841/api/pipeline
```

```json
{
  "as_of": "2026-08-18T19:59:52.343Z",
  "stall_threshold_hours": 48,
  "stall_cutoff": "2026-08-16T19:59:52.343Z",
  "phases": [
    {
      "key": "idea",
      "label": "Idea",
      "description": "Topic + brief, pre-script",
      "statuses": [],
      "count": 0,
      "stalled_count": 0,
      "state": "no_work_idle",
      "state_reason": "Nothing in Idea, and it is the first phase — no work has been created.",
      "cards": [],
      "cards_truncated": false
    },
    {
      "key": "script",
      "label": "Script",
      "description": "Scripting → script ready",
      "statuses": [],
      "count": 0,
      "stalled_count": 0,
      "state": "no_work_idle",
      "state_reason": "Nothing in Script, and nothing in any earlier phase — idle, not blocked.",
      "cards": [],
      "cards_truncated": false
    },
    {
      "key": "voice",
      "label": "Voice",
      "description": "TTS generation",
      "statuses": [],
      "count": 0,
      "stalled_count": 0,
      "state": "no_work_idle",
      "state_reason": "Nothing in Voice, and nothing in any earlier phase — idle, not blocked.",
      "cards": [],
      "cards_truncated": false
    },
    {
      "key": "assets",
      "label": "Assets",
      "description": "Image / clip / asset collection",
      "statuses": [],
      "count": 0,
      "stalled_count": 0,
      "state": "no_work_idle",
      "state_reason": "Nothing in Assets, and nothing in any earlier phase — idle, not blocked.",
      "cards": [],
      "cards_truncated": false
    },
    {
      "key": "qc",
      "label": "QC",
      "description": "QMS validation + manual gates",
      "statuses": [
        "AWAITING_QC",
        "AWAITING_UPLOADER"
      ],
      "count": 5,
      "stalled_count": 5,
      "state": "has_work",
      "state_reason": "5 jobs in QC.",
      "cards": [
        {
          "id": "c65abcfe-a6cc-465a-bd78-368c5dbfbb0d",
          "title": "MacBook Air M3 vs Dell XPS 15",
          "status": "AWAITING_UPLOADER",
          "format": "TECH_COMPARISON",
          "channel": "Content Forge Main",
          "template": "Comparison X vs Y — Software",
          "age": "11d",
          "updated_at": "2026-08-06 21:50:26.252+00",
          "status_updated_at": "2026-08-06 21:50:26.252+00",
          "stalled": true,
          "stall_days": 11
        },
        {
          "id": "75c0cbe8-ed38-48b0-9b26-8e1c591f10c5",
          "title": "Best budget standing desks under 400",
          "status": "AWAITING_UPLOADER",
          "format": "RANKING",
          "channel": "Blink Blueprint",
          "template": "Ranking Default",
          "age": "12d",
          "updated_at": "2026-08-05 21:26:34.847+00",
          "status_updated_at": "2026-08-05 21:26:34.847+00",
          "stalled": true,
          "stall_days": 12
        },
        {
          "id": "bd4bfd38-bf92-4b0f-8fda-145e5feb72f5",
          "title": "Best budget mechanical keyboards under 150",
          "status": "AWAITING_UPLOADER",
          "format": "RANKING",
          "channel": "Blink Blueprint",
          "template": "Ranking Default",
          "age": "12d",
          "updated_at": "2026-08-05 20:37:24.549+00",
          "status_updated_at": "2026-08-05 20:37:24.549+00",
          "stalled": true,
          "stall_days": 12
        },
        {
          "id": "6a9341e6-ef76-4735-b92b-54f5eb26a34d",
          "title": "Best Speakers 2026 below 100$",
          "status": "AWAITING_QC",
          "format": "RANKING",
          "channel": "Your VirtualFD",
          "template": "Ranking Default",
          "age": "14d",
          "updated_at": "2026-08-04 11:53:01.457+00",
          "status_updated_at": "2026-08-04 11:53:01.457+00",
          "stalled": true,
          "stall_days": 14
        },
        {
          "id": "797bc9b0-44e7-43dc-a187-6d1fd5732816",
          "title": "Best noise cancelling headphones under 300",
          "status": "AWAITING_UPLOADER",
          "format": "RANKING",
          "channel": "Blink Blueprint",
          "template": "Ranking Default",
          "age": "14d",
          "updated_at": "2026-08-04 01:01:34.885+00",
          "status_updated_at": "2026-08-04 01:01:34.885+00",
          "stalled": true,
          "stall_days": 14
        }
      ],
      "cards_truncated": false
    },
    {
      "key": "render",
      "label": "Render",
      "description": "Routing + render + stitch",
      "statuses": [],
      "count": 0,
      "stalled_count": 0,
      "state": "no_work_blocked_upstream",
      "state_reason": "Nothing in Render — 5 jobs held further up, in QC (5). This column is empty because work is stuck, not because there is none.",
      "cards": [],
      "cards_truncated": false
    },
    {
      "key": "publish",
      "label": "Publish",
      "description": "Uploader → published",
      "statuses": [],
      "count": 0,
      "stalled_count": 0,
      "state": "no_work_blocked_upstream",
      "state_reason": "Nothing in Publish — 5 jobs held further up, in QC (5). This column is empty because work is stuck, not because there is none.",
      "cards": [],
      "cards_truncated": false
    }
  ],
  "total": 5,
  "stalled_total": 5,
  "card_limit_per_phase": 20,
  "card_query_limit": 500,
  "card_rows_scanned": 5,
  "workers": {
    "ok": true,
    "as_of": "2026-08-18T19:59:52.346Z",
    "workers": [
      {
        "name": "worker-orchestrator",
        "status": "online",
        "uptime_ms": 659996103,
        "restarts": 0
      },
      {
        "name": "worker-render",
        "status": "online",
        "uptime_ms": 659996102,
        "restarts": 0
      },
      {
        "name": "worker-video-stitch",
        "status": "online",
        "uptime_ms": 659996087,
        "restarts": 0
      },
      {
        "name": "claude-pool",
        "status": "online",
        "uptime_ms": 659996138,
        "restarts": 0
      }
    ],
    "online": 4,
    "expected": [
      "worker-orchestrator",
      "worker-render",
      "worker-video-stitch",
      "claude-pool"
    ],
    "missing": []
  },
  "queues": {
    "ok": true,
    "as_of": "2026-08-18T19:59:52.351Z",
    "endpoint": "127.0.0.1:6379",
    "probed_queues": 8,
    "queues": [
      {
        "queue": "queue-ingest",
        "sets": [
          {
            "set": "wait",
            "key": "bull:queue-ingest:wait",
            "redis_type": "none",
            "depth": null
          },
          {
            "set": "active",
            "key": "bull:queue-ingest:active",
            "redis_type": "none",
            "depth": null
          },
          {
            "set": "delayed",
            "key": "bull:queue-ingest:delayed",
            "redis_type": "none",
            "depth": null
          },
          {
            "set": "failed",
            "key": "bull:queue-ingest:failed",
            "redis_type": "none",
            "depth": null
          },
          {
            "set": "completed",
            "key": "bull:queue-ingest:completed",
            "redis_type": "zset",
            "depth": 2
          },
          {
            "set": "paused",
            "key": "bull:queue-ingest:paused",
            "redis_type": "none",
            "depth": null
          }
        ]
      },
      {
        "queue": "queue-ai-generation",
        "sets": [
          {
            "set": "wait",
            "key": "bull:queue-ai-generation:wait",
            "redis_type": "none",
            "depth": null
          },
          {
            "set": "active",
            "key": "bull:queue-ai-generation:active",
            "redis_type": "none",
            "depth": null
          },
          {
            "set": "delayed",
            "key": "bull:queue-ai-generation:delayed",
            "redis_type": "none",
            "depth": null
          },
          {
            "set": "failed",
            "key": "bull:queue-ai-generation:failed",
            "redis_type": "none",
            "depth": null
          },
          {
            "set": "completed",
            "key": "bull:queue-ai-generation:completed",
            "redis_type": "none",
            "depth": null
          },
          {
            "set": "paused",
            "key": "bull:queue-ai-generation:paused",
            "redis_type": "none",
            "depth": null
          }
        ]
      },
      {
        "queue": "queue-asset-collection",
        "sets": [
          {
            "set": "wait",
            "key": "bull:queue-asset-collection:wait",
            "redis_type": "none",
            "depth": null
          },
          {
            "set": "active",
            "key": "bull:queue-asset-collection:active",
            "redis_type": "none",
            "depth": null
          },
          {
            "set": "delayed",
            "key": "bull:queue-asset-collection:delayed",
            "redis_type": "none",
            "depth": null
          },
          {
            "set": "failed",
            "key": "bull:queue-asset-collection:failed",
            "redis_type": "zset",
            "depth": 5
          },
          {
            "set": "completed",
            "key": "bull:queue-asset-collection:completed",
            "redis_type": "zset",
            "depth": 86
          },
          {
            "set": "paused",
            "key": "bull:queue-asset-collection:paused",
            "redis_type": "none",
            "depth": null
          }
        ]
      },
      {
        "queue": "queue-clip-selection",
        "sets": [
          {
            "set": "wait",
            "key": "bull:queue-clip-selection:wait",
            "redis_type": "none",
            "depth": null
          },
          {
            "set": "active",
            "key": "bull:queue-clip-selection:active",
            "redis_type": "none",
            "depth": null
          },
          {
            "set": "delayed",
            "key": "bull:queue-clip-selection:delayed",
            "redis_type": "none",
            "depth": null
          },
          {
            "set": "failed",
            "key": "bull:queue-clip-selection:failed",
            "redis_type": "none",
            "depth": null
          },
          {
            "set": "completed",
            "key": "bull:queue-clip-selection:completed",
            "redis_type": "none",
            "depth": null
          },
          {
            "set": "paused",
            "key": "bull:queue-clip-selection:paused",
            "redis_type": "none",
            "depth": null
          }
        ]
      },
      {
        "queue": "queue-qms-validation",
        "sets": [
          {
            "set": "wait",
            "key": "bull:queue-qms-validation:wait",
            "redis_type": "none",
            "depth": null
          },
          {
            "set": "active",
            "key": "bull:queue-qms-validation:active",
            "redis_type": "none",
            "depth": null
          },
          {
            "set": "delayed",
            "key": "bull:queue-qms-validation:delayed",
            "redis_type": "none",
            "depth": null
          },
          {
            "set": "failed",
            "key": "bull:queue-qms-validation:failed",
            "redis_type": "none",
            "depth": null
          },
          {
            "set": "completed",
            "key": "bull:queue-qms-validation:completed",
            "redis_type": "zset",
            "depth": 1
          },
          {
            "set": "paused",
            "key": "bull:queue-qms-validation:paused",
            "redis_type": "none",
            "depth": null
          }
        ]
      },
      {
        "queue": "queue-render-heavy",
        "sets": [
          {
            "set": "wait",
            "key": "bull:queue-render-heavy:wait",
            "redis_type": "none",
            "depth": null
          },
          {
            "set": "active",
            "key": "bull:queue-render-heavy:active",
            "redis_type": "none",
            "depth": null
          },
          {
            "set": "delayed",
            "key": "bull:queue-render-heavy:delayed",
            "redis_type": "none",
            "depth": null
          },
          {
            "set": "failed",
            "key": "bull:queue-render-heavy:failed",
            "redis_type": "none",
            "depth": null
          },
          {
            "set": "completed",
            "key": "bull:queue-render-heavy:completed",
            "redis_type": "zset",
            "depth": 1
          },
          {
            "set": "paused",
            "key": "bull:queue-render-heavy:paused",
            "redis_type": "none",
            "depth": null
          }
        ]
      },
      {
        "queue": "queue-video-stitch",
        "sets": [
          {
            "set": "wait",
            "key": "bull:queue-video-stitch:wait",
            "redis_type": "none",
            "depth": null
          },
          {
            "set": "active",
            "key": "bull:queue-video-stitch:active",
            "redis_type": "none",
            "depth": null
          },
          {
            "set": "delayed",
            "key": "bull:queue-video-stitch:delayed",
            "redis_type": "none",
            "depth": null
          },
          {
            "set": "failed",
            "key": "bull:queue-video-stitch:failed",
            "redis_type": "none",
            "depth": null
          },
          {
            "set": "completed",
            "key": "bull:queue-video-stitch:completed",
            "redis_type": "zset",
            "depth": 1
          },
          {
            "set": "paused",
            "key": "bull:queue-video-stitch:paused",
            "redis_type": "none",
            "depth": null
          }
        ]
      },
      {
        "queue": "queue-auto-label",
        "sets": [
          {
            "set": "wait",
            "key": "bull:queue-auto-label:wait",
            "redis_type": "none",
            "depth": null
          },
          {
            "set": "active",
            "key": "bull:queue-auto-label:active",
            "redis_type": "none",
            "depth": null
          },
          {
            "set": "delayed",
            "key": "bull:queue-auto-label:delayed",
            "redis_type": "none",
            "depth": null
          },
          {
            "set": "failed",
            "key": "bull:queue-auto-label:failed",
            "redis_type": "none",
            "depth": null
          },
          {
            "set": "completed",
            "key": "bull:queue-auto-label:completed",
            "redis_type": "none",
            "depth": null
          },
          {
            "set": "paused",
            "key": "bull:queue-auto-label:paused",
            "redis_type": "none",
            "depth": null
          }
        ]
      }
    ]
  }
}
```

### 3a. R64 — the five stalled jobs, with their real ages

Every one of the five renders `stalled: true` with the age
`premises-remeasured.md` § P2 measured independently by `psql`:

| id | status | stall_days | `status_updated_at` | P2's `psql` age |
|---|---|---|---|---|
| `c65abcfe` | AWAITING_UPLOADER | 11 | 2026-08-06 21:50:26.252+00 | 11 days 21:51:21 |
| `75c0cbe8` | AWAITING_UPLOADER | 12 | 2026-08-05 21:26:34.847+00 | 12 days 22:15:13 |
| `bd4bfd38` | AWAITING_UPLOADER | 12 | 2026-08-05 20:37:24.549+00 | 12 days 23:04:23 |
| `6a9341e6` | AWAITING_QC | 14 | 2026-08-04 11:53:01.457+00 | 14 days 07:48:46 |
| `797bc9b0` | AWAITING_UPLOADER | 14 | 2026-08-04 01:01:34.885+00 | 14 days 18:40:13 |

`stall_threshold_hours: 48` is published in the response, so no label anywhere
downstream has to hardcode 48. The negative half of R64 — a fresh job renders
NOT stalled — is proved in `pipeline-health.test.ts`, because there is no fresh
job in `content_jobs` and R68 forbids creating one.

### 3b. R65 — six empty columns, two different reasons, in words

```
idea     count=0 stalled=0 no_work_idle              | Nothing in Idea, and it is the first phase — no work has been created.
script   count=0 stalled=0 no_work_idle              | Nothing in Script, and nothing in any earlier phase — idle, not blocked.
voice    count=0 stalled=0 no_work_idle              | Nothing in Voice, and nothing in any earlier phase — idle, not blocked.
assets   count=0 stalled=0 no_work_idle              | Nothing in Assets, and nothing in any earlier phase — idle, not blocked.
qc       count=5 stalled=5 has_work                  | 5 jobs in QC.
render   count=0 stalled=0 no_work_blocked_upstream  | Nothing in Render — 5 jobs held further up, in QC (5). This column is empty because work is stuck, not because there is none.
publish  count=0 stalled=0 no_work_blocked_upstream  | Nothing in Publish — 5 jobs held further up, in QC (5). This column is empty because work is stuck, not because there is none.
```

That is R65 discharged on the live data: `Idea` and `Publish` both render `0`
and now say opposite things about why.

### 3c. The two fake counts, fixed

`count` and `total` no longer come from an array length. `count` is a
`GROUP BY` over every matching row (no `LIMIT`), `total` is their sum, and the
card cap is published beside them instead of masquerading as the count:

```
total: 5                      (TRUE count — was r.rows.length under LIMIT 500)
stalled_total: 5
card_limit_per_phase: 20      (the cap that used to BE `count`)
card_query_limit: 500
card_rows_scanned: 5          (== card_query_limit would mean the card query capped)
```

Each phase also carries `cards_truncated`, so a 30-job phase shows 20 cards and
says `count: 30`, rather than silently reporting 20.

As § P2 established, the caps do not bind at today's data, so **this fix is not
visible in any screenshot** — it is proved by the shape of the response and by
reading the query. That is the whole reason it was folded in here (N8) instead
of being seeded as its own cycle.

### 3d. R66 — four workers, from a real `pm2 jlist`

`online: 4`, `missing: []`, uptimes ~660,000,000 ms ≈ **7.6 days**, `restarts: 0`
— which corroborates `S-C` §2 exactly. `uptime_ms` is `null`, never `0`, for a
process pm2 does not report as online: a zero uptime reads as "just restarted",
which is the opposite of "not running".

### 3e. R67 — real queue depths, and a finding

The probe speaks RESP over `node:net`; **no redis client was added** (`pnpm add`
under this runtime's pruning has bricked the executor before). Eight named
mainline queues, confirmed against
`/opt/content-forge/apps/worker-orchestrator/src/utils/dispatch-next.ts` and
`packages/queue/src/constants/queue-names.ts` — not all 47 under `bull:*`, the
rest being other product lines.

The non-zero depths it returns match `S-C` §1's independent `ioredis` probe
row for row:

| queue | this probe | S-C §1 |
|---|---|---|
| `queue-ingest` | completed 2 | completed 2 |
| `queue-asset-collection` | failed 5, completed 86 | failed 5, completed 86 |
| `queue-qms-validation` | completed 1 | completed 1 |
| `queue-render-heavy` | completed 1 | completed 1 |
| `queue-video-stitch` | completed 1 | completed 1 |

**FINDING, and it changes what builder 3 renders.** Every `wait`, `active`,
`delayed` and `paused` key on every probed queue answers `TYPE` with `none` —
the key **does not exist**. S-C §1 reported `waiting: 0` / `active: 0` because
`ioredis`'s `LLEN` on a missing key returns `0`; asking `TYPE` first shows the
difference. It is not a contradiction: **Redis deletes a list or zset the
moment it becomes empty**, so for a BullMQ set an absent key and an empty
collection are the same operational fact. Confirmed against the busiest queues
on the box, which have failure history and still have no `wait` key:

```
### CMD-10  (read-only: TYPE / ZCARD only)
queue-tutorial-generate       wait=none/absent active=none/absent delayed=none/absent failed=zset/47 completed=zset/205 paused=none/absent
queue-tech-footage-collection wait=none/absent active=none/absent delayed=none/absent failed=zset/1  completed=zset/1   paused=none/absent
queue-garbage-collection      wait=none/absent active=none/absent delayed=none/absent failed=none/absent completed=zset/1 paused=none/absent
```

So the correct render, **and only when `queues.ok === true`**, is
`0 waiting (queue empty)` — not `unknown`, and not a bare `0` that would also
be what a dead probe produced. When `queues.ok === false` there is no number to
show at all. The API keeps `depth: null` rather than coercing to `0` because
the coercion is only sound for `list`/`zset` semantics under a **successful**
probe, and that judgement belongs to the renderer that has the `ok` flag in
hand, not to a field that gets read without it.

---

## 4. The failure paths, proved — not asserted

A probe that has never been seen to fail is a probe you do not know the failure
shape of. Each of the three was produced deliberately.

### 4a. Redis unreachable (R67)

```
### CMD-11
$ REDIS_URL=redis://127.0.0.1:6399 SERVE_PIPELINE_PORT=7841 \
    ./node_modules/.bin/tsx .../serve-pipeline.ts &
$ curl -sS http://127.0.0.1:7841/api/pipeline | node -e '<print .queues>'
```

```json
{
  "queues": {
    "ok": false,
    "as_of": "2026-08-18T20:00:40.557Z",
    "endpoint": "127.0.0.1:6399",
    "error": "connect ECONNREFUSED 127.0.0.1:6399"
  }
}
```

`workers.ok: true` / `online: 4` and `total: 5` / `stalled_total: 5` in the same
response — a dead redis degrades its own panel and nothing else.

### 4b. pm2 fails (R66)

```
### CMD-12  pm2 exits non-zero
$ printf '#!/bin/sh\necho "[PM2][ERROR] Daemon not running / connection refused" >&2\nexit 1\n' > /tmp/p5-fakebin/pm2
$ PATH=/tmp/p5-fakebin:$PATH SERVE_PIPELINE_PORT=7841 ./node_modules/.bin/tsx .../serve-pipeline.ts &
$ curl -sS http://127.0.0.1:7841/api/pipeline
{"ok":false,"as_of":"2026-08-18T20:01:30.228Z","expected":["worker-orchestrator","worker-render","worker-video-stitch","claude-pool"],"error":"[PM2][ERROR] Daemon not running / connection refused"}
    rest of pipeline unaffected: total=5 stalled_total=5 queues.ok=true

### CMD-13  pm2 present but printing something that is not JSON — the case a
###          `try { JSON.parse } catch { return [] }` would have reported as
###          "no workers online" for a perfectly healthy fleet
$ printf '#!/bin/sh\necho "[PM2] spawning PM2 daemon..."\n' > /tmp/p5-fakebin/pm2
$ curl -sS http://127.0.0.1:7841/api/pipeline
{"ok":false,"as_of":"2026-08-18T20:01:02.545Z","expected":["worker-orchestrator","worker-render","worker-video-stitch","claude-pool"],"error":"parsePm2Jlist: pm2 jlist did not return JSON (Unexpected token 'P', \"[PM2] spawn\"... is not valid JSON); stdout began \"[PM2] spawning PM2 daemon...\\n\""}
```

Note what `expected` does in the failure body: it names the four processes that
were *supposed* to be probed, so a broken probe still tells the surface what it
was unable to say anything about.

### 4c. What "unreachable" is NOT

There is no `catch` returning a default, no `?? 0`, and no degrade-to-healthy
anywhere in the two probes — and here is the grep, including the two hits it
does return, because a claim of "no hits" that a reviewer can falsify in one
command is worse than no claim:

```
### CMD-14
$ grep -n '?? 0' <the five source files>
forge-control/src/lib/redis-probe.ts:28: * third answer and no `?? 0` anywhere in this file.

$ grep -n 'catch\s*{' forge-control/src/lib/{redis-probe,pipeline-health}.ts forge-control/src/db/pipeline.ts
forge-control/src/lib/redis-probe.ts:155:  } catch {

$ grep -nw 'any' <the five source files>
(three hits, all the English word "any" inside a comment)
```

Both code hits are benign and neither is a default:

- `redis-probe.ts:28` is **prose** — the file's own header stating the rule. A
  file that names its own forbidden string trips its own audit; scope the grep
  to non-comment lines or read the hit.
- `redis-probe.ts:155` is `parseRedisUrl`'s `catch { throw new Error(...) }`.
  It has no binding because the `URL` constructor's own message adds nothing;
  it re-throws with the offending string. It returns no value at all.

The three `catch` blocks that DO return a value are the deliberate ones:
`probeQueueDepths` → `{ok: false, error}`, and `getWorkerHealth`'s two →
`{ok: false, error}`. All three carry the upstream message verbatim.

---

## 5. R68 self-audit — what the reviewer's grep will and will not find

```
### CMD-15
$ grep -rn "pm2 restart\|pm2 delete\|pm2 stop" <the five source files>
  none
$ grep -inE '"(SET|DEL|LPUSH|RPUSH|ZADD|FLUSH[A-Z]*|RENAME|EXPIRE)"' forge-control/src/lib/redis-probe.ts
  none — only TYPE / LLEN / ZCARD / AUTH / SELECT
```

**One warning for whoever runs the R68 grep.** A case-insensitive
`grep -iE 'INSERT|UPDATE|DELETE|TRUNCATE'` over this diff returns six hits, and
every one is the new field name **`cards_truncated`** (plus one comment
containing the word "truncated"). Grep case-sensitively for SQL keywords, or
the audit reports a write that does not exist. All four SQL statements in the
lane are `SELECT`; both live in `db/pipeline.ts` and are quoted in full there.

---

## 6. What is still owed, and by whom

- **The surface.** Everything above is JSON. `PipelineSurface.tsx` renders none
  of it yet — that is builder 3. The contract is `app/api-business.ts`, which
  exports exactly `fetchPipelineBusiness()`, `BusinessPipelineCard`,
  `BusinessPipelinePhase`, `WorkerHealth`, `QueueDepth`,
  `BusinessPipelineResponse` (plus `BusinessPhaseState`, `WorkerHealthResult`,
  `QueueProbeResult`, `QueueSetDepth`, which the six named types refer to).
- **The `wait`-key semantics of §3e** are the one judgement call this task made
  that the brief did not cover, and builder 3 must not render `absent` as
  `unknown`.
- **The eighth bucket.** S-C §3 and § P1 both argue `qc` conflates a machine
  gate (`QMS_VALIDATING`) with a human gate (`AWAITING_UPLOADER`) that no
  worker will ever pick up. This task did NOT split the bucket — it is a change
  to the phase model, not to expressiveness, and the brief scopes this task to
  the latter. The new `state_reason` sentences make the stall unmissable
  without it; the split remains open.
