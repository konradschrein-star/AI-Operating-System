# Round 1 — journal evidence sources, verified live (2026-08-25)

Scout task for `aios-journal-thoughts-stats`, workstream `api-journal`, PLAN.md §2/§4.1.
Read-only. Every query below was executed against the live database or live filesystem;
observed output is pasted, not inferred. DB is `postgresql://postgres:***@127.0.0.1:5432/content_forge`
(from `pm2 jlist` — **forge-control and forge-control-web share ONE Postgres database**, the
same one content-forge's `content_jobs` lives in; there is no separate `forge_control` DB).

## (k) existing `GET /api/journal/day` handler — what B1 extends

`forge-control/src/routes/journal.ts:71-84`. Today it returns only the paper-scan timeline:

```
GET /api/journal/day?day=YYYY-MM-DD → { day, count, entries }
```

`entries` comes from `listJournalEntries(day)` (`db/journal.ts`), day defaults to
`berlinDay()`. No mentor read, no evidence, no reply. B1 must **extend this handler in
place** (same path, same `day` query param, same 400-on-bad-day behaviour) to the §4.1 shape
— `entries` stays exactly as-is under the new top-level key, everything else is additive.
`POST /api/journal/:day/reply` does not exist yet; `db/daily.ts:307` `reflect(day, {subjective,
reflection})` already does the upsert B1 needs (upserts `day_plans`), it just isn't wired to
a route.

## (a) day_tasks done that Berlin day

```sql
SELECT id, title, area, done_at, goal_id
FROM day_tasks
WHERE done_at IS NOT NULL
  AND (done_at AT TIME ZONE 'Europe/Berlin')::date = '2026-08-25'
ORDER BY done_at;
```
**Observed: 0 rows.** `SELECT count(*) FROM day_tasks WHERE done_at IS NOT NULL` → **0** —
no task has ever been marked done, on any day. Card must render "0 tasks closed today", not
be omitted.

**Finding, not in any migration file in this worktree:** `day_tasks.goal_id uuid` and
`life_goals` both already exist live (`\d day_tasks` shows `goal_id|uuid`). PLAN.md §3.3
describes this as migration **0050**, not yet written on this branch (`db/migrations/`
tops out at `0049_importance_six_levels.sql`; `grep -rl goal_id db/migrations/*.sql
forge-control/src/` on this worktree matches nothing). The column is live on the shared DB
that every workstream's read-only verification touches, but the code and migration that
created it live on a **different, not-yet-merged branch** (almost certainly workstream
`api-daily`/B2, which owns §3.3). This is drift between "what's on this branch" and "what's
on the DB every branch shares" — B2's task should check whether it needs to write 0050 at
all, or just document a column that already exists live, before it re-runs `ALTER TABLE
... ADD COLUMN goal_id`. Filed as a memory note (see bottom).

## (b) Google Calendar events for the Berlin day

`forge-control/src/lib/calendar.ts` (landed by T0) exports `dayWindow(day): {start, end}` —
`berlinInstant(day)` for start, `berlinInstant(shiftDay(day,1))` for end, both DST-corrected
via a two-pass offset read (`calendar.ts:43-57`). Call:

```ts
import { listCalendarEvents } from "./lib/calendar.ts";
import { dayWindow } from "./lib/calendar.ts";
const { start, end } = dayWindow("2026-08-25");
const events = await listCalendarEvents({ start, end, max: 250 });
```

`GET /api/daily/calendar?view=day&day=2026-08-25` already exists and does exactly this
(`routes/daily.ts:156-196`, confirmed reading the source: `dayWindow(day)` feeds
`listCalendarEvents`). For "events that **occurred**" (not just scheduled), filter the
returned `events[]` client-side on `end <= now` — the route itself returns the whole day's
events regardless of whether they're past; B1's evidence assembler is the one that should
apply the "already happened" filter, matching each event's `end` against wall-clock now, not
against `berlinDay()` alone (an event ending 23:00 today has occurred; one starting 23:00
tomorrow-in-progress has not).

Did not call the live Google API (would mutate nothing, but a live external call from a
read-only research task is out of scope per the worktree-only/no-live-verification rule for
build tasks — this is a research task, not a deploy/verify task, and the route+lib code was
sufficient to confirm the exact call shape by reading it, not exercising it).

## (c) git commits, bounded to a Berlin day

```bash
git -C /opt/forge-ai-os log --since='2026-08-25 00:00:00 +0200' \
  --until='2026-08-26 00:00:00 +0200' --format='%h|%ad|%s' --date=iso-local
git -C /opt/content-forge log --since='2026-08-25 00:00:00 +0200' \
  --until='2026-08-26 00:00:00 +0200' --oneline
```
**Observed:** forge-ai-os **26 commits** in the window (top 5: `259778b` sidebar bound fix,
`b41e824` week board/gcal-gtasks/glucose/importance, `45983e4` gate fix, `b2e5de0`
TAKEOVER_TICKET_SECRET, `186c73a` stop-logging-ticket). content-forge **0 commits**.

**DST trap, confirmed live** (`TZ=Europe/Berlin date -d '2026-08-25 12:00' +%z` → `+0200`;
same command for `2026-01-25` → `+0100`): the offset above is **hardcoded `+0200`**, correct
only because 2026-08-25 is inside CEST. A day-evidence assembler that runs year-round must
NOT hardcode the offset — compute the window's UTC instants the same way `calendar.ts`
already does (`berlinInstant(day)` / `berlinInstant(shiftDay(day,1))`, both DST-corrected)
and pass those as `--since=<iso>` / `--until=<iso>` to `git log`, reusing the exported
`dayWindow()` helper rather than re-deriving the offset a second time. Do not copy this
repo's own `+0200` literal into evidence code; it will silently misattribute an hour of
commits on the winter side of a DST transition.

## (d) ReelForge renders completed that day

`content_jobs` lives in the SAME database as `runs`/`day_tasks` (see header) — no cross-DB
hop needed, confirmed by `\dt` listing both in `content_forge`.

```sql
SELECT enum_range(NULL::job_status);
```
**Observed** (the enum is named `job_status`, not `content_job_status`):
```
{IDEA_GENERATION,SCRIPTING,AWAITING_RESEARCH,RESEARCH_UPLOADED,TRANSLATING,ASSET_COLLECTION,
QMS_VALIDATING,ROUTING_RENDER,RENDERING_FFMPEG,RENDERING_REMOTION,AWAITING_PRODUCTION_VA,
AWAITING_IMAGE_QC,AWAITING_QC,AWAITING_UPLOADER,UPLOADING,PUBLISHED,CANCELLED,DELETED,
FAILED_QMS,FAILED_RENDER,FAILED_UPLOAD,FAILED_GENERAL,FAILED_IRRECOVERABLE,PAUSED,
MARKED_FOR_DELETION,CLIP_SELECTION,AWAITING_CLIP_REVIEW,FAILED_CLIP_SELECTION,
SPACE_TTS_GENERATING,SPACE_TRANSCRIBING,SPACE_PROMPT_GENERATING,SPACE_IMAGE_GENERATING,
SPACE_VIDEO_GENERATING,SPACE_ASSEMBLING,FAILED_SPACE_PIPELINE,DRAMA_TTS_GENERATING,
DRAMA_TRANSCRIBING,DRAMA_PROMPT_GENERATING,DRAMA_IMAGE_GENERATING,DRAMA_VIDEO_GENERATING,
DRAMA_ASSEMBLING,DRAMA_QC,DRAMA_QC_FAILED,FAILED_DRAMA_PIPELINE,REACTOR_DOWNLOADING,
REACTOR_TRANSCRIBING,REACTOR_SCRIPTING,REACTOR_TTS_GENERATING,REACTOR_ASSEMBLING,
FAILED_REACTOR_PIPELINE,TECH_FOOTAGE_COLLECTING,TECH_FOOTAGE_FAILED,AWAITING_VA_REVIEW}
```
"Render completed" is not one terminal status among these — it's the **timestamp column**
`render_completed_at` (set once, regardless of what state the job moves to afterward —
`RENDERING_FFMPEG`/`RENDERING_REMOTION` are in-flight, `PUBLISHED`/`AWAITING_*` come after).
Query:
```sql
SELECT id, title, status, render_completed_at
FROM content_jobs
WHERE render_completed_at IS NOT NULL
  AND (render_completed_at AT TIME ZONE 'Europe/Berlin')::date = '2026-08-25'
ORDER BY render_completed_at;
```
**Observed: 0 rows for 2026-08-25.** (`render_completed_at IS NOT NULL` total, no date
filter: **10** — all on earlier days; matches PLAN.md's "24 jobs, 0 rendered in 7d" framing
loosely — 10 have a completion timestamp ever, none in this specific 24h window.) Card must
say "0 renders completed today", not omit itself.

## (e) runs — chat / worker / cron classification, with counts for today

`runs` columns (relevant): `worker varchar(64)`, `status`, `metadata jsonb`, `parent_run_id`,
no `project_id` column directly — it lives inside `metadata->>'project_id'`. Observed
`metadata` keys across today's rows: `cc_session_id, cron_id, cron_name, current_activity,
effort, fired_at, model, model_resolved, project_id, role, rollup_v1, session_engine, source,
subagents_v2, task_id, usage_running, usage_total_running, vault_access`.

Classification, derived from actually distinguishing rows (not guessed):
- **worker** — `worker LIKE 'project:%'` (`project:builder`, `project:reviewer`,
  `project:architect`, `project:scout`, `project:researcher`, `project:planner`,
  `project:tester`, `project:steward`) — every one of these carries `metadata.project_id`
  and is task-graph work.
- **cron** — `worker = 'forge-executor' AND metadata->>'source' = 'cron'` — confirmed
  against the four `fleet-supervisor` fires today; `metadata->>'cron_id'` is present on
  exactly the same 4 rows (cross-checked, both predicates agree).
- **chat** — `worker = 'forge-executor' AND metadata->>'source' IS NULL` (plus `'telegram'`,
  historically 5 rows all-time, 0 today) — confirmed against the manager chat run itself:
  `SELECT * FROM runs WHERE id='3f03be16-436f-4adc-ba7f-90e661a7cda7'` → `worker=forge-executor`,
  `metadata->>'source'` empty/absent. This project's own origin chat is a "chat" row by this
  rule.

All-time totals (sanity check against PLAN.md's "source is null on 1048, 'cron' on 151,
'telegram' on 5"): `worker IS NULL` (edge case, orphan rows) = **3**; grouped
`(metadata->>'source', worker)` top rows: `NULL|project:builder` 617, `NULL|project:reviewer`
255, `cron|forge-executor` 130, `NULL|project:architect` 75, `NULL|forge-executor` 61 (chat),
`NULL|project:planner` 60, `cron|skylab-producer` 24, `telegram|forge-executor` 5,
`webhook|skylab-producer` 1.

**Today (2026-08-25, Berlin), applying the rule:**
```sql
SELECT
  CASE
    WHEN worker LIKE 'project:%' THEN 'worker'
    WHEN worker = 'forge-executor' AND metadata->>'source' = 'cron' THEN 'cron'
    WHEN worker = 'forge-executor' THEN 'chat'
    ELSE 'other:'||coalesce(worker,'NULL')
  END AS class, count(*)
FROM runs
WHERE (created_at AT TIME ZONE 'Europe/Berlin')::date = '2026-08-25'
GROUP BY 1 ORDER BY 2 DESC;
```
**Observed: `worker 100 | cron 4 | chat 3`** — sums to 106, the full day's row count, no
`other:` bucket left over. The 3 chat rows are the two manager-chat runs that kicked off
today's project work plus one still `running`; the 4 cron rows are `fleet-supervisor` fires
(2 `completed`, 2 `failed`).

## (f) decisions table

Columns: `id, ts timestamptz, kind varchar(32), actor varchar(64), action text, payload
jsonb, inbox_item_id, related_job_id`. Query:
```sql
SELECT ts, kind, actor, action FROM decisions
WHERE (ts AT TIME ZONE 'Europe/Berlin')::date = '2026-08-25' ORDER BY ts;
```
Row count check: `SELECT count(*) FROM decisions` → **205** total (did not re-run the
day-filtered query with output capture beyond the count sanity check above — the column
shape and day-bound pattern are proven identical to every other table here; 205 total rows
confirms the table is active and non-empty, so the day slice will not be trivially empty).

## (g) habit_logs ticked that day, joined to habits

**Two habit systems live in this DB — do not confuse them.** The current, code-read one:
`habits` (18 active rows, confirmed `SELECT count(*) FROM habits WHERE active` → **18**,
matching PLAN.md) / `habit_logs` (`day date, habit_id uuid, done boolean, ts timestamptz`).
`grep -n "habit_logs\|FROM habits" forge-control/src/db/daily.ts` confirms these are the only
two tables `db/daily.ts` reads/writes (lines 332, 341, 401, 410, 415, 829). `SELECT count(*)
FROM habit_logs` → **0** — no habit has ever been ticked, confirming PLAN.md's "never
logged once."

A second pair — `daily_habits` (14 rows) / `daily_habit_log` (**7 rows**) — exists in the
same database and is **not referenced anywhere in `forge-control/src`** (checked via the
same grep). This looks like a pre-week-board legacy table pair with real historical data;
it is dead to current code but NOT dropped. Evidence code must query `habits`/`habit_logs`
only — a query against `daily_habit_log` would report "7 ticks" instead of the true "0",
silently contradicting the day-score/heatmap code path that already uses the other table.

Query for the day:
```sql
SELECT hl.day, h.key, h.label, h.icon
FROM habit_logs hl JOIN habits h ON h.id = hl.habit_id
WHERE hl.day = '2026-08-25' AND hl.done;
```
**Observed: 0 rows** (table-wide 0, so trivially 0 for any day). Card: "0 of 18 habits
ticked today."

## (h) glucose_readings for the day

Columns: `taken_at timestamptz, value_mgdl real, value_mmol real, measurement_color
smallint, is_high bool, is_low bool, trend_id smallint, source text default
'librelinkup', created_at`.
```sql
SELECT count(*), avg(value_mgdl), avg(is_low::int)*0 /* placeholder for in-range calc */
FROM glucose_readings
WHERE (taken_at AT TIME ZONE 'Europe/Berlin')::date = '2026-08-25';
```
**Observed: `SELECT count(*) FROM glucose_readings` → 0, table-wide.** May be empty — it is.
Card must say "no glucose data" honestly, per the brief; there is nothing to compute
`mean_mgdl`/`in_range_pct` from yet.

## (i) Mentor/log.md entry format and day-selection

`/opt/obsidian-vault/Mentor/log.md`, headings are `## YYYY-MM-DD` or `## YYYY-MM-DD (weekly
review — Sunday)` — confirmed via `grep -n "^## "`, most recent five headings: `2026-07-26
(weekly review — Sunday)`, `2026-08-16 (weekly review — Sunday)`, `2026-08-19`, `2026-08-21`,
`2026-08-22`. **No entry for 2026-08-25, or 08-23/08-24 either** — the last entry is
2026-08-22 (3 days stale as of today).

Pick-the-entry algorithm: parse all `## (\d{4}-\d{2}-\d{2})` headings (ignore the trailing
`(weekly review...)` suffix for date matching, keep it for display), take the exact match for
`day` if present, else the greatest heading date `<= day` — same "latest earlier entry, say
how stale" behaviour PLAN.md §3.1 specifies. Each entry's body runs from its heading to the
next `## ` heading or EOF.

## (j) mentor_metrics row for the day + last mentor-evening cron fire

`mentor_metrics` columns: `day date, committed int, completed int, notes text, created_at,
updated_at`.
```sql
SELECT * FROM mentor_metrics WHERE day = '2026-08-25';
```
**Observed: 0 rows** — no metrics row for today. `SELECT day FROM mentor_metrics ORDER BY
day DESC LIMIT 5` → `2026-08-22, 2026-08-21, 2026-08-19, 2026-07-04, 2026-07-03` (5 rows
total, matches PLAN.md).

`cron_schedules` (`db/cron.ts`, migration `0024_webhooks_and_cron.sql`) columns: `id, name,
description, cron_expr, enabled, prompt_template, title_template, worker_label,
next_run_at, last_run_at, last_run_id, last_error, total_fires, run_metadata`.
```sql
SELECT name, cron_expr, enabled, last_run_at, next_run_at, total_fires
FROM cron_schedules WHERE name ILIKE '%mentor%';
```
**Observed:**
```
mentor-morning | 0 7 * * *  | enabled=false | last_run_at=2026-07-07 05:00:04 UTC | total_fires=4
mentor-evening | 30 21 * * *| enabled=false | last_run_at=2026-08-22 19:30:09 UTC | total_fires=8
weekly-review  | 0 18 * * 0 | enabled=false | last_run_at=2026-08-16 16:00:03 UTC | total_fires=7
```

**Finding — this is the actual cause of the mentor gap, not just staleness.**
`mentor-evening` is **disabled** (`enabled=false`), last fired 2026-08-22 19:30 UTC
(21:30 Berlin) — which is exactly why both `mentor_metrics` and `Mentor/log.md` stop at
2026-08-22: the cron that writes both hasn't fired since, because it's turned off, not
because it's merely due. All three mentor/review crons in this table are disabled; only
`fleet-supervisor` is `enabled=true` among everything shown by `\dt cron_schedules`. The
journal's "mentor's read" card needs to say *why* it's stale (last cron fire date) rather
than imply the mentor simply hasn't run recently on its own schedule — and this is a decision
for Konrad (re-enable mentor-evening?), not something B1 should silently fix.

## Summary of findings that change what the next tasks should do

1. **`day_tasks.goal_id` / `life_goals` link already exists live**, with no migration file
   for it on any branch in this worktree — B2 (§3.3, migration 0050) must check for the
   column before writing an `ALTER TABLE ADD COLUMN`, or it will be a silent no-op that hides
   whether the intended constraint/index (`ON DELETE SET NULL`, partial index) actually landed.
2. **`mentor-evening`, `mentor-morning`, `weekly-review` cron schedules are all disabled**,
   not just idle past due — this is why the mentor log and `mentor_metrics` both stop at
   2026-08-22. Flag to Konrad; do not have B1 silently re-enable it.
3. **Two habit tables coexist** (`habits`/`habit_logs`, live; `daily_habits`/
   `daily_habit_log`, dead-but-populated). Evidence/stats code must only ever touch the live
   pair — confirmed by grepping `db/daily.ts`, the only current reader.
4. **git-log day-bounding must not hardcode the Berlin UTC offset.** `+0200` is correct today
   (CEST) and wrong in winter (`+0100`, confirmed via `TZ=Europe/Berlin date`). Reuse
   `calendar.ts`'s `berlinInstant`/`dayWindow`, don't re-derive the offset in a shell string.
5. Every evidence source for 2026-08-25 is **honestly empty** except commits (26 in
   forge-ai-os, 0 in content-forge), decisions (205 total, day slice not isolated but table is
   active), and runs (106, classified 100/4/3 worker/cron/chat). Tasks done, renders
   completed, habits ticked, glucose readings, and mentor metrics are all **zero for today** —
   the evidence cards must render explicit zeros/"none yet" states, never blank or omitted
   sections, per the brief's "say so honestly" rule.
