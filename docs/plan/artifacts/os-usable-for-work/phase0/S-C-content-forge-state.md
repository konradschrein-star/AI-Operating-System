# S-C — Content Forge live state and why QC has been stuck

Scout round 499, workstream `business`, read-only against Content Forge. All commands run from
this worktree against the live `content_forge` Postgres (127.0.0.1:5432), the live Redis
(127.0.0.1:6379), and live `pm2 jlist` on this box (65.108.6.149). No write, no `pm2 restart`,
no job mutation was executed. Baseline this scout extends: `docs/plan/os-usable-for-work/00-vision.md`
§2.5 (5 jobs stalled 11–14 days: 3 AWAITING_UPLOADER, 2 AWAITING_QC).

**Correction to the §2.5 baseline:** re-measured now (2026-08-18T19:10Z), the live split is
**4 `AWAITING_UPLOADER` + 1 `AWAITING_QC`**, not 3+2. Same total (5), same age band (11–14 days),
same root cause. Command:

```
psql -U postgres -h 127.0.0.1 -d content_forge -c \
  "SELECT status, count(*) FROM content_jobs WHERE status NOT IN
   ('MARKED_FOR_DELETION','DELETED','CANCELLED','PUBLISHED') GROUP BY status;"

      status       | count
--------------------+-------
 AWAITING_QC        |     1
 AWAITING_UPLOADER  |     4
```

Phase 5 (R64) should render whichever split is live at build/verify time, not hardcode 3/2.

---

## 1. BullMQ / Redis — reachable, all queues empty

Redis is reachable (`redis-server *:6379` in `ps aux`, confirmed by an `ioredis` connection from
`/opt/content-forge`'s own `node_modules`; `redis-cli` binary is not installed on this box, so the
probe used `ioredis` directly — same protocol, same data). **This box can reach it; say so, but
also record that `redis-cli` is absent so a future scout doesn't burn time looking for it.**

```
cd /opt/content-forge && node -e "
const Redis = require('ioredis');
const r = new Redis('redis://127.0.0.1:6379');
(async () => {
  const keys = await r.keys('bull:*');
  console.log('TOTAL bull: keys:', keys.length);
})();"
→ TOTAL bull: keys: 618
```

47 distinct queue names exist under `bull:*` (full list in the round-499 research doc). Depth per
queue (`wait`/`active`/`delayed`/`failed`/`completed`/`paused` list/zset lengths), queues with any
non-zero count only:

```
queue-asset-collection        {"waiting":0,"active":0,"delayed":0,"failed":5,"completed":86,"paused":0}
queue-cf-finishing-render     {"waiting":0,"active":0,"delayed":0,"failed":0,"completed":13,"paused":0}
queue-cf-raw-render           {"waiting":0,"active":0,"delayed":0,"failed":0,"completed":5,"paused":0}
queue-garbage-collection      {"waiting":0,"active":0,"delayed":0,"failed":0,"completed":1,"paused":0}
queue-ingest                  {"waiting":0,"active":0,"delayed":0,"failed":0,"completed":2,"paused":0}
queue-qms-validation          {"waiting":0,"active":0,"delayed":0,"failed":0,"completed":1,"paused":0}
queue-render-heavy            {"waiting":0,"active":0,"delayed":0,"failed":0,"completed":1,"paused":0}
queue-tech-footage-collection {"waiting":0,"active":0,"delayed":0,"failed":1,"completed":1,"paused":0}
queue-tutorial-generate       {"waiting":0,"active":0,"delayed":0,"failed":47,"completed":205,"paused":0}
queue-tutorial-splice         {"waiting":0,"active":0,"delayed":0,"failed":0,"completed":114,"paused":0}
queue-tutorial-stitch         {"waiting":0,"active":0,"delayed":0,"failed":0,"completed":2,"paused":0}
queue-video-stitch            {"waiting":0,"active":0,"delayed":0,"failed":0,"completed":1,"paused":0}
```

Every other queue (including `queue-cf-ingest`, `queue-drama-*`, `queue-reactor-*`,
`queue-bundestag-*`) is entirely absent of counters — those are other product lines
(tutorial-line, drama, reactor, bundestag), not the 5 content_forge jobs in question.

**`waiting=0` and `active=0` on every queue.** This is the load-bearing fact for Q4: nothing is
queued, nothing is running. The 5 stuck jobs are not sitting in a BullMQ backlog anywhere. Phase 5
(R67) can render real depths from this same `ioredis` probe; the pattern is
`bull:<queue>:wait|active|delayed|failed|completed|paused`.

**What "unreachable" must look like (Phase 5 needs this even though this probe succeeded):** an
`ioredis` connection to a wrong/dead host throws `ECONNREFUSED` or times out per its
`connectTimeout`; catch that and render `queue not reachable: <error.message>`, never a bare `0`.
`0` and "unreachable" are answered by the exact same shape of empty result if you don't catch the
throw.

## 2. pm2 — four workers online, 7.6-day uptime, no errors relevant to these 5 jobs

`pm2 jlist` (run 2026-08-18T19:10:10Z), Content Forge processes only:

| name | status | uptime | restarts |
|---|---|---|---|
| `claude-pool` | online | 7.6 days | 0 |
| `worker-orchestrator` | online | 7.6 days | 0 |
| `worker-render` | online | 7.6 days | 0 |
| `worker-video-stitch` | online | 7.6 days | 0 |
| `hub-web` | online | — (not queried) | — |

(`thumbnail-worker`, a different project's pm2 process, is `stopped` — irrelevant to Content
Forge.)

**Which worker should have picked up an `AWAITING_QC`/`AWAITING_UPLOADER` job: none of them.**
This is not a worker failing to notice work — it is by design. `dispatch-next.ts` (the single
place that routes a status transition to a queue) has explicit `case` branches:

```
apps/worker-orchestrator/src/utils/dispatch-next.ts:24-25 (doc comment)
 * - AWAITING_QC → no dispatch (awaits VA action)
 * - AWAITING_UPLOADER → no dispatch (awaits VA action)

apps/worker-orchestrator/src/utils/dispatch-next.ts:169-231 (code)
case "AWAITING_UPLOADER": { ...enqueues a thumbnail as a side effect only...
  console.log(... "No dispatch - awaiting human action or external process" ...)
  return null;
}
...
case "AWAITING_RESEARCH":
case "RESEARCH_UPLOADED":
case "AWAITING_PRODUCTION_VA":
case "AWAITING_IMAGE_QC":
case "AWAITING_VA_REVIEW":
case "AWAITING_CLIP_REVIEW":
case "AWAITING_QC":
case "UPLOADING":
  console.log(... "No dispatch - awaiting human action or external process" ...)
```

`worker-orchestrator` error log (`/opt/content-forge/logs/worker-orchestrator-error.log`, last 50
lines, tail run today) is active and noisy, but every entry is about a **different** product line
— tutorial-job thumbnail rendering (`h264_nvenc`/CUDA failures on a GPU-less box, falling back to
libx264) and a VEO fleet reporting `no_workers_online, queue_stalled, pending=566` for tutorial
thumbnails. None of it references any of the 5 `content_jobs` rows. `worker-render` and
`worker-video-stitch` error logs are empty (0 lines). `claude-pool` error log is empty.

**Conclusion: nothing crashed and nothing is misrouting.** The workers are healthy and idle with
respect to these 5 jobs because the code that would dispatch them explicitly refuses to.

## 3. `content_jobs.status` enum — 53 values, and the phase mapping

Full enum (`SELECT enumlabel FROM pg_enum e JOIN pg_type t ON e.enumtypid=t.oid WHERE
t.typname='job_status' ORDER BY e.enumsortorder`) — 53 rows. Grouped into the 7 phases the
Pipeline surface renders (idea, script, voice, assets, render, publish, **plus an 8th bucket this
scout is adding: QC/upload gate**, since neither "render" nor "publish" honestly contains it):

| Phase | Statuses |
|---|---|
| idea | `IDEA_GENERATION` |
| script | `SCRIPTING`, `AWAITING_RESEARCH`, `RESEARCH_UPLOADED`, `TRANSLATING` |
| voice | *(no dedicated enum value in the mainline pipeline — TTS statuses live under the DRAMA_*/SPACE_*/REACTOR_* alt-pipelines, e.g. `DRAMA_TTS_GENERATING`, `SPACE_TTS_GENERATING`, `REACTOR_TTS_GENERATING`)* |
| assets | `ASSET_COLLECTION`, `CLIP_SELECTION`, `AWAITING_CLIP_REVIEW`, `TECH_FOOTAGE_COLLECTING`, `TECH_FOOTAGE_FAILED` |
| render | `QMS_VALIDATING`, `ROUTING_RENDER`, `RENDERING_FFMPEG`, `RENDERING_REMOTION`, `AWAITING_PRODUCTION_VA`, `AWAITING_IMAGE_QC` |
| **QC/upload gate (human)** | **`AWAITING_QC`, `AWAITING_UPLOADER`, `AWAITING_VA_REVIEW`, `UPLOADING`** |
| publish | `PUBLISHED` |
| terminal/failure (not a pipeline stage) | `CANCELLED`, `DELETED`, `MARKED_FOR_DELETION`, `PAUSED`, `FAILED_QMS`, `FAILED_RENDER`, `FAILED_UPLOAD`, `FAILED_GENERAL`, `FAILED_IRRECOVERABLE`, `FAILED_CLIP_SELECTION`, `FAILED_SPACE_PIPELINE`, `FAILED_DRAMA_PIPELINE`, `FAILED_REACTOR_PIPELINE` |
| other product lines, not this pipeline | `DRAMA_*` (7 values), `SPACE_*` (6 values), `REACTOR_*` (5 values) — separate content formats sharing the same `content_jobs` table and enum |

If Phase 5 keeps a flat 7-bucket model, both `AWAITING_QC` and `AWAITING_UPLOADER` are being
folded into "render" today — that is the actual defect R65 is naming: a job that finished
rendering and is waiting on a **human**, not a worker, renders identically to a job mid-render.
Recommend the 8th bucket above, or at minimum a `blocked_on: "VA"` flag surfaced on any job in
`render` that's actually in the QC/upload gate.

## 4. Why has nothing moved — root cause, with evidence

**A human QC/upload gate that nobody has opened.** Two independent pieces of evidence converge:

1. **The code refuses to dispatch these statuses to any queue** (§2 above,
   `dispatch-next.ts:24-25,169-238` — verbatim comment: "awaits VA action" / "awaiting human action
   or external process"). This is intentional design, not a bug: `AWAITING_UPLOADER` even
   side-effects a thumbnail generation so it's *ready* for the human, then explicitly stops.

2. **No VA is assigned to any of the 5 jobs.** `content_jobs.assigned_production_va_id` and
   `assigned_uploader_va_id` are both `NULL` on all 5 rows:

   ```
   psql ... -c "SELECT id, status, assigned_production_va_id, assigned_uploader_va_id,
                 worker_lease_id FROM content_jobs WHERE status IN ('AWAITING_QC','AWAITING_UPLOADER');"
   → all 5 rows: assigned_production_va_id = NULL, assigned_uploader_va_id = NULL, worker_lease_id = NULL
   ```

   `apps/hub-web` (pm2 `hub-web`, **online**, port 3000) is the VA portal —
   `assignProductionVA()`/`assignUploaderVA()` live at
   `apps/hub-web/src/app/actions/jobs.ts:862,893` and are the only code path that would move a
   human into ownership of one of these jobs. It is running and reachable; nobody has visited it
   and clicked assign on these 5 rows since they arrived (earliest: `797bc9b0`, 14 days ago).

3. One of the 5 (`6a9341e6`, the sole `AWAITING_QC` row) additionally carries a **failed QC
   verdict already recorded** in its history, not a pending one:
   ```
   state_machine_history (last entry): {"reason": "QA FAILED: Video is frozen for 5.1s in one run
   (from 10.9s) and 3% of runtime in total. A frozen picture is what shipped on 2026-07-09.",
   "to_status": "AWAITING_QC", "from_status": "RENDERING_REMOTION"}
   ```
   This job isn't waiting for a first QC pass — it already failed one, 14 days ago, and is waiting
   for a human to either re-render or override. `qc_feedback` and `qc_reviewed_at` columns are both
   still `NULL`, meaning even the failing QC verdict was never formally recorded through the QC
   review action — it was written by the render pipeline itself as an automated frozen-frame check.

**This changes what Phase 5 must show**: not "queue depth is low," but "there is a portal
(`hub-web`, running, port 3000) with 5 unassigned jobs waiting on a human, oldest 14 days." A
worker-health/queue-depth panel alone would still under-report the actual blocker.

## 5. Cheapest reliable signal for "this job is stalled": `status_updated_at`

**It is reliably maintained, but by application code, not a database trigger — verified, not
assumed:**

- There **is** a Postgres trigger that stamps a status-change timestamp in this schema
  (`log_bundestag_status_change()`, `packages/db/src/migrations/0000_yummy_squadron_sinister.sql:565-577`),
  but it fires on `bundestag_status`/`bundestag_jobs`, a **different table** for the BUNDESTAG
  product line. Confirmed live that no such trigger exists on `content_jobs`:
  ```
  psql ... -c "SELECT tgname FROM pg_trigger WHERE tgrelid='content_jobs'::regclass AND NOT tgisinternal;"
  → (0 rows)
  ```
- Instead, `status_updated_at` on `content_jobs` is set in application code, and there is exactly
  **one** function that changes `status`: `updateJobStatus()`
  (`packages/db/src/repositories/job-repository.ts:188-222`), which sets `status` and
  `status_updated_at: new Date()` in the same object literal of the same `UPDATE`, so the two
  columns cannot drift apart within that call. `createJob()` (line 37-56) does the same on insert.
  A grep for any other caller writing `status:` through the generic `updateJob()` escape hatch
  (`job-repository.ts:156`) found none outside `job-repository.ts` itself across
  `apps/` and `packages/`.
- **Conclusion: `status_updated_at` age is safe to use as the stall signal**, on the current
  codebase, because there is exactly one write path and it always pairs the two columns. The one
  risk this scout could not close in read-only scope: a future direct SQL `UPDATE content_jobs SET
  status = ...` (a manual DBA fix, a migration, a one-off script) would silently bypass this and
  go undetected, because there is no DB-level trigger as a backstop the way `bundestag_status` has.
  Phase 5 should treat `status_updated_at` as trustworthy today but not assume it forever — a
  cheap follow-up (out of this scout's scope) would be adding the same trigger pattern to
  `content_jobs`.

---

## Appendix: raw commands for re-verification

```bash
# Redis reachability + queue depths (no redis-cli on this box — use ioredis from content-forge's own deps)
cd /opt/content-forge && node -e "const Redis=require('ioredis'); const r=new Redis('redis://127.0.0.1:6379'); ..."

# pm2
pm2 jlist
pm2 logs <name> --err --lines 50 --nostream

# Postgres (content_forge, read-only)
export PGPASSWORD='<from /opt/content-forge/.env DATABASE_URL, read-only use>'
psql -U postgres -h 127.0.0.1 -d content_forge -c "\d content_jobs"
psql -U postgres -h 127.0.0.1 -d content_forge -c "SELECT enumlabel FROM pg_enum e JOIN pg_type t ON e.enumtypid=t.oid WHERE t.typname='job_status' ORDER BY e.enumsortorder;"
psql -U postgres -h 127.0.0.1 -d content_forge -c "SELECT status, count(*) FROM content_jobs WHERE status NOT IN ('MARKED_FOR_DELETION','DELETED','CANCELLED','PUBLISHED') GROUP BY status;"
psql -U postgres -h 127.0.0.1 -d content_forge -c "SELECT id, status, status_updated_at, now()-status_updated_at AS age, assigned_production_va_id, assigned_uploader_va_id FROM content_jobs WHERE status IN ('AWAITING_QC','AWAITING_UPLOADER');"
psql -U postgres -h 127.0.0.1 -d content_forge -c "SELECT tgname FROM pg_trigger WHERE tgrelid='content_jobs'::regclass AND NOT tgisinternal;"
```

No `INSERT`/`UPDATE`/`DELETE` was executed against `content_forge`. No `pm2 restart` was executed.
