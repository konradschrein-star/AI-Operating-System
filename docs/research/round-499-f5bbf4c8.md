# Round 499 — Scout S-C: Content Forge live state and why QC has been stuck

Full findings committed at
`docs/plan/artifacts/os-usable-for-work/phase0/S-C-content-forge-state.md` (the phase-0 deliverable
named in `04-phases.md`). This file is the round pointer + summary a planner can act on without
opening the artifact.

## One-line answer

**Root cause of the 11–14 day stall: it isn't a stall in the queueing sense at all.**
`AWAITING_QC`/`AWAITING_UPLOADER` are, by explicit design in `dispatch-next.ts`, statuses that
**no worker ever picks up** — they exist to hand a finished render to a human VA via the `hub-web`
portal (pm2, online, port 3000). All 5 jobs have `assigned_production_va_id` /
`assigned_uploader_va_id` = `NULL`. Nobody has opened the portal and assigned themself to any of
these 5 rows since the oldest arrived 14 days ago. Workers, Redis and BullMQ are all healthy and
correctly idle with respect to these jobs — there is nothing there for them to do.

## What changed vs. the 00-vision.md §2.5 baseline

Baseline said 3 `AWAITING_UPLOADER` + 2 `AWAITING_QC`. Re-measured now: **4 `AWAITING_UPLOADER` +
1 `AWAITING_QC`**, same total of 5, same 11–14 day age band. Cite the live split, not the vision
doc's, when Phase 5 builds — it will keep moving by small amounts as VAs occasionally touch a row
manually outside the portal.

## Answers to the 5 brief questions (detail + commands in the artifact)

1. **BullMQ/Redis**: reachable via `ioredis` (no `redis-cli` binary on this box — use
   `/opt/content-forge`'s own `ioredis` dependency instead). 47 queue names exist; every one has
   `waiting=0, active=0` right now. Nothing is queued anywhere for these 5 jobs.
2. **pm2**: `claude-pool`, `worker-orchestrator`, `worker-render`, `worker-video-stitch` all
   `online`, 7.6-day uptime, 0 restarts. Error logs are active but 100% about a *different* product
   line (tutorial thumbnails hitting a GPU-less CUDA failure + a stalled VEO fleet) — zero log lines
   reference any of the 5 `content_jobs` in question. **No worker "should" have picked these up —
   the routing code explicitly refuses to dispatch `AWAITING_QC`/`AWAITING_UPLOADER` to any queue.**
3. **Status enum**: 53 values. Mapped to the 7 Pipeline-surface phases in the artifact; flagged that
   `AWAITING_QC`/`AWAITING_UPLOADER`/`AWAITING_VA_REVIEW`/`UPLOADING` don't honestly belong in
   "render" — they're a human gate and Phase 5 should probably render them as their own bucket, not
   fold them into render-in-progress.
4. **Why nothing moved**: confirmed human QC/upload gate, `hub-web` running and reachable, nobody
   assigned. One job additionally already has a **failed** QC verdict on record (frozen-frame
   detector caught a regression matching one that shipped 2026-07-09) — it isn't pending first
   review, it's pending someone acting on a failure that's sat for 14 days.
5. **Stall signal**: `status_updated_at` age is safe to use. It's set by application code (exactly
   one function, `updateJobStatus()`, sets `status` and `status_updated_at` atomically in the same
   `UPDATE`; no other code path writes `status`), **not** by a DB trigger — a same-named trigger
   pattern exists in this schema but is scoped to a different table/product line (`bundestag_status`),
   so it's not a backstop here. Trustworthy today; would silently break under a future manual SQL
   `UPDATE` with no trigger to catch it.

## What this changes for the Phase 5 planner (R64–R68)

- R64/R66/R67 (stall age, worker health, queue depth) are all buildable exactly as specified — real
  data exists for all three, and "unreachable" has a defined shape (`ioredis` connection error,
  caught and rendered as `queue not reachable: <message>` — never a bare 0).
- R65 ("no work" vs "work stuck") needs a third state beyond those two: **"stuck on a human,"**
  because these jobs aren't stuck on a worker or a queue at all — they're a completed hand-off
  waiting on `hub-web`. A pipeline view that only distinguishes worker-side no-work vs worker-side
  stuck-work will still misrepresent this specific stall as "render is slow" rather than "nobody
  has opened the VA portal in two weeks." Recommend the Pipeline surface link out to (or at least
  name) `hub-web` for jobs in this state.
- Confirmed strictly read-only: no `INSERT`/`UPDATE`/`DELETE` against `content_forge`, no
  `pm2 restart`, during this scout.
