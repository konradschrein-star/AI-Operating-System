# Phase 300 — Read-side API: execution plan (planner, round 300)

Scope law: `10-ui-v3-spec.md` → `12-ui-v3-requirements.md` (U1–U8, NFU4/5) → `13-ui-v3-architecture.md §3–§5` → `14-ui-v3-quality.md`.
**forge-control ONLY. Zero web files. Route-local SQL. Forbidden to touch: `project-tick.ts`, `cc-runner.ts`, `executor.ts`, `db/projects.ts`, `FileExplorerPanel*`, `VaultFileList*`, `routes/files.ts`.**

## Round map

| Round | Task | Files (exclusive) |
|---|---|---|
| 301 | Baseline curl transcript + normalizer + generalized :7798 harness | `scripts/checks/serve-v3-7798.ts` (new), `scripts/checks/api-diff.sh` (new), `docs/plan/artifacts/phase300/baseline/*` |
| 302 | `agents-shared.ts` extraction (the touchy refactor) — gated by 301's diff | `forge-control/src/routes/agents-shared.ts` (new), `forge-control/src/routes/agents.ts` |
| 303a | `GET /api/capabilities` (U8) + mounts | `forge-control/src/routes/capabilities.ts` (new), `forge-control/src/index.ts`, `scripts/checks/serve-v3-7798.ts` |
| 303b | Working-time module + unit check (U5) | `forge-control/src/routes/working-time.ts` (new), `scripts/checks/check-working-time.ts` (new) |
| 303c | `requested_by_run_id` on mark-pending (U7) | `forge-control/src/routes/secrets.ts`, `forge-control/src/lib/secret-store.ts` |
| 303d | `origin_chat_id` at `POST /api/projects` (U1) | `forge-control/src/routes/projects.ts`, `scripts/checks/check-project-metadata.ts` (new) |
| 304 | Linkage resolver + `/api/chat` rollup + backfill (U2, U3) | `forge-control/src/routes/chat-linkage.ts` (new), `forge-control/src/routes/chat.ts` |
| 305 | `GET /api/chat/:id/team` (U4, U5 wiring) | `forge-control/src/routes/chat.ts` |
| 306 | `GET /api/chat/:id/plan` + `/plan/doc` (U6) | `forge-control/src/routes/chat.ts` |
| 307 | Reviewer — universal gates + phase-300 protocols | artifacts only |

303a–303d run in parallel (disjoint files). 304/305/306 are strictly sequential: all three edit `chat.ts`.

## Riskiest step

**Round 302 — the `agents.ts` helper extraction.** It refactors code two reviewers already passed (phases 1–2, time truth + kind truth), and every later round imports the result. A silent shape change to `/api/agents` breaks the shipped Live panel with no compile error.

Mitigation: 301 records the pre-change transcript BEFORE 302 exists; 302's own gate is a byte-equal normalized diff.
**Rollback line:** `git checkout <round-301-commit> -- forge-control/src/routes/agents.ts && git rm forge-control/src/routes/agents-shared.ts` — agents.ts is otherwise untouched by this phase, so reverting it costs nothing downstream except re-doing 302.

Second risk: **the 304 backfill UPDATE** — the only write in the phase.
**Rollback line:** `UPDATE projects SET metadata = metadata - 'origin_chat_id' WHERE id IN (<ids listed in artifacts/phase300/backfill.log>);` (run only on instruction; the builder MUST log every id it writes).

## Facts established by the planner (use these, don't re-derive)

- **DB:** `postgresql://…@127.0.0.1:5432/content_forge`, env at `/opt/ai-os/.secrets/forge-control.env` (`set -a; . /opt/ai-os/.secrets/forge-control.env; set +a`).
- **Tasks table is `project_tasks`**, not `tasks`. Columns: `id, project_id, round, role, title, brief, status, run_id, fix_cycle, tier, attempt, created_at, updated_at`. `status ∈ pending|ready|running|done|failed|blocked`. `run_id` is the FK from a task to the CC run that executed it — that is how a worker row gets its task title/round.
- **`projects.workspace_dir`** for this project = `/opt/ai-os/workspace/projects/8ea0cc08-28d9-4301-9f28-c98e1c5d6838`; plan docs live under `<workspace_dir>/docs/plan/`.
- **`runs.thread`** entries: `{role, content, ts, kind?, meta?}`; `ts` is ISO-8601 and reliably present.
- **Working-time is cheap in SQL.** Measured by the planner: gap-sum with a 120 s cap over all 12 runs of this project = **30 ms** total.
  ```sql
  SELECT (SELECT sum(least(extract(epoch FROM (b.ts-a.ts))*1000, 120000))
          FROM (SELECT (e->>'ts')::timestamptz ts, row_number() OVER () rn
                  FROM jsonb_array_elements(r.thread) e) a
          JOIN (SELECT (e->>'ts')::timestamptz ts, row_number() OVER () rn
                  FROM jsonb_array_elements(r.thread) e) b ON b.rn = a.rn+1) AS working_ms
    FROM runs r WHERE r.metadata->>'project_id' = $1;
  ```
  Sanity from the same run: this project's workers have `working_ms ≈ wall_ms` (e.g. 949 813 vs 949 322) — they really do work continuously; the cap earns its keep on operator chats and queue waits, not on builders.
- **`fetchActiveRows()` in agents.ts is NOT reusable as-is for the team endpoint**: it carries a 24 h recency window and `LIMIT 60`. The team query must be its own route-local SQL, scoped by `metadata->>'project_id'` with **no** recency filter (a chat opened next week must still show its finished team). Reuse the *shaping* helpers, not the query.
- **Linkage ground truth (pinned test fixtures):**
  - `bfd1283a-b71b-4f35-b577-7d09aad803f2` — the operator chat that created **both** `8ea0cc08…` (operator-visibility) and `4120f785…` (engine-v2-research-lane) via real `POST /api/projects` calls. Expected: resolves, `link_source:"thread_scan"`, **`link_ambiguous: true`**, newest-created wins (`4120f785…`, created 06:46:35, one second after `8ea0cc08…`). Honesty beats a pretty answer here — do NOT special-case it.
  - A naive "uuid appears anywhere in thread" scan is useless: that chat mentions 5 project uuids and `a86cf7b3…` mentions 7 (task-posting curls, GET dumps, git commands). The scan MUST be bounded to `tool_call` entries containing a POST to `/api/projects` **with no further path segment** (`/api/projects/<uuid>/tasks` is task creation, not project creation) and take the uuid from the following `tool_result`, validated against the `projects` table.
  - No project row currently carries `metadata.origin_chat_id` (all 8 NULL) — the `link_source:"metadata"` case must be created by the test itself (303d probe or a backfill).
- **Harness (:7798):** `scripts/checks/serve-agents-7798.ts` mounts exactly one router over node:http and proxies everything else to :7700, **buffered**. Two constraints when generalizing it: never boot `src/index.ts` (it starts cron/telegram/vault ticks against the same DB and bot token), and keep `GET /api/chat/:id/events` on the *proxy* path — the buffered writer would hang an SSE stream forever.
