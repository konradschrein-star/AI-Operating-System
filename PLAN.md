# aios-journal-thoughts-stats — plan (round 0)

**Goal.** Rebuild JOURNAL so it opens full, add THOUGHTS, give LIFE GOALS a home on the
week board, and bring back stats — one `StatsPanel` mounted on both JOURNAL and GOALS/TASKS.

**Governing rule.** THE PAGE MUST BE FULL BEFORE KONRAD TOUCHES IT. Everything on screen is
derived; his input is a correction (a rating, a reply, a link, a status). No gates, no rituals.

## 0. Recommendation, in one paragraph

Land the live checkout's uncommitted week-board work onto this branch first (it is the sole
copy; see §1), then build four backend lanes and one web lane **in parallel** against the
JSON contracts pinned in §4 of this document, integrate each lane back serially, review once,
deploy once. JOURNAL becomes *mentor's read → evidence of the day → your reply → stats*, with
the paper scanner collapsed to the bottom. THOUGHTS is a frontmatter-file store in the vault
with a default view of **not-started ideas, oldest first**. LIFE GOALS is a drawer on the
week board plus `day_tasks.goal_id` (migration 0050) so the board can answer "did this week
move anything that matters". The vault split (`Konrad/` vs `Forge/`) ships as a **mechanism
behind a layout flag plus a dry-run move script**; nothing relocates until Konrad says go.

## 1. Blocker found during recon — the live checkout is the only copy

`/opt/forge-ai-os` (branch `main`, HEAD `186c73a` = this branch's base) carries **15 modified +
18 untracked files, uncommitted, on no branch anywhere**: the week board (`goals/WeekGrid.tsx`,
`TaskRail.tsx`, `HabitStrip.tsx`, `TaskDetail.tsx`, `pressure.ts`, rewritten
`GoalsSurface.tsx`), the Google Calendar + Google Tasks two-way sync (`lib/calendar-sync*.ts`,
`lib/gtasks*.ts`), glucose (`lib/glucose*.ts`, `db/glucose.ts`), `quick-parse.ts`, and
migrations **0047–0049** (already applied to the live DB). mtimes 01:20–03:11 on 2026-08-25
match the Operator Log entries: this is Konrad's own chat-built work, not debris.

Everything this project builds sits on those files. Per the standing ruling
(`AI OS/Operator Decisions.md` § "When the live checkout goes dirty"): preserve, never
discard. Task T0 copies them onto this branch as one commit with a sha256 manifest; the
deploy task uses the manifest to prove the live tree has not moved before it merges.
Konrad has been asked (manager chat) whether he prefers to commit them in place on `main`
now; either answer merges clean because the content is byte-identical on both sides.

## 2. Measured state (live DB, 2026-08-25)

| table | rows | consequence |
|---|---|---|
| `life_goals` | 11 (2 in_progress, 9 planned; 3 quarterly / 4 yearly / 4 long_term) | surface opens full; no seeding needed |
| `day_plans.subjective` non-null | **0** | habit↔felt tile must open honest |
| `habit_logs` | **0** (18 active habits) | heatmap opens honest; no chart of nothing |
| `day_tasks` | 5 (0 done, 3 gcal-linked, 3 gtask-linked) | goal link starts empty; suggestion only |
| `journal_entries` (paper) | 0 | scanner is demoted, kept |
| `mentor_metrics` | 5; `Mentor/log.md` last entry 2026-08-22 | "mentor's read" must say when it is stale |
| `runs` today | 49 (`metadata.source`: null 1048 / cron 151 / telegram 5) | classify runs by columns, not by source alone |
| `content_jobs` | 24, 0 rendered in 7 d — **lives in forge-control's own DB** (`127.0.0.1:5432/content_forge`) | renders are one SQL away, no cross-DB hop |
| git | forge-ai-os 22 commits today, content-forge 0 | `git log --since` per repo works |

## 3. Design

### 3.1 JOURNAL (rewrite `JournalSurface.tsx`; left column top→bottom)
1. Day nav (keep).
2. **MENTOR'S READ** — the `## <day>` entry of `/opt/obsidian-vault/Mentor/log.md` for the
   selected day, else the latest entry ≤ day with a visible "last mentor entry: <day>, N days
   ago" line; plus `mentor_metrics` for the day and the streak. Never blank: if the log has no
   entry at all, say so and show when the evening mentor cron last fired.
3. **WHAT HAPPENED** — evidence cards from `GET /api/journal/day` (§4.1): tasks closed,
   calendar events that occurred, commits per repo, ReelForge renders, runs (chat / worker /
   cron counts + top items), habits ticked, glucose summary if any. A source that failed shows
   its error inline in its own card (`errors[]`), never an empty list.
4. **YOUR REPLY** — felt rating 1–10 (ten buttons, current value lit) + a textarea prefilled
   with the existing reflection; one Save → `POST /api/journal/:day/reply`. Writing is a reply
   to the evidence above it, not a blank page.
5. **STATS** — `<StatsPanel mount="journal" />` (§3.4).
6. Collapsed disclosures at the bottom: *Paper capture* (`PaperCaptureDeck`, unchanged) and
   *Edit day note* (`JournalVaultEditor`, unchanged). `DailyDecisionsStream` is folded into
   the runs card (decisions are one evidence source now).
Right column: `MentorAgentDeck` + `MentorCronSwitch` as today — it is the part that already
has content.

### 3.2 THOUGHTS (new surface `thoughts`, nav group `recall`, between GOALS/TASKS and JOURNAL)
Files in the vault, read and written through forge-control (`lib/thoughts.ts`,
`routes/thoughts.ts` mounted at `/api/thoughts`). Frontmatter is the schema:

```
---
type: idea
idea: "<one line>"
area: business | youtube | life | health | relationships
importance: 1-10
status: not-started | started | executing | done | dropped
created: YYYY-MM-DD
author: konrad | forge
source: konrad | derived:<vault path>
---
## Description
…
## Why it is genius
…
```
Paths (§3.5 layout-aware): Konrad's ideas `Thoughts/Ideas/<YYYY-MM-DD>-<slug>.md`; agent-derived
seeds `Forge/Thoughts/Seeds/<same>` — the pool is the union, seeds carry a *derived* badge, and
**Adopt** moves the file to his side (that is the correction). Quotes and dreams are two
append-only lists: `Thoughts/Quotes.md`, `Thoughts/Dreams.md` (`- "…" — source (date)`).
Default view: `status = not-started`, sorted by **age since `created`, oldest first**, age shown
in days — his own doctrine ("un-executed ideas are bullshit") as the landing view. Other views:
by area, by importance, executed. Seeding (page must be full): the deploy task runs
`scripts/seed-thoughts.ts --dry-run` first, which derives seeds from the four root `Project - *`
notes, `Mentor/Profile/Goals & Aspirations.md` bullets without a `life_goals` row, `Inbox/`,
and `#idea`-tagged notes — every seed says which note it came from.

### 3.3 LIFE GOALS on the week board
- Migration **0050**: `day_tasks.goal_id uuid NULL REFERENCES life_goals(id) ON DELETE SET
  NULL` + partial index. `POST/PATCH /api/daily/tasks` accept `goal_id`.
- `GET /api/daily/goals` gains derived fields per goal: `tasks_open`, `tasks_done_30d`,
  `minutes_30d`, `last_moved_at`. Read-time `suggested_goal_id` on tasks (exactly one
  `in_progress` goal with the same area) — a suggestion chip, never a silent write.
- Board header: `LIFE GOALS · 11` button opening a right-side drawer (same pattern as
  `TaskDetail`): goals grouped by horizon, status/progress inline, add goal; and a one-line
  strip "this week moved: <goal> (n) · … · k done tasks unlinked". `TaskDetail` gets a goal
  picker. A `STATS` toggle in the header swaps the rail+grid for `<StatsPanel mount="goals" />`.

### 3.4 ONE StatsPanel (`app/desktop/stats/StatsPanel.tsx`, mounted in both surfaces)
Window 30/90. Tiles, each with its own query, its own loading and its own error (a Google
outage blanks one tile, not the panel). Invoke the `dataviz` skill before drawing anything.
- **ScoreTrend** — `days[].score` line + 7-day moving average (reuse `ui.tsx` `Line`,
  `StatsTab.movingAverage`), felt rating overlaid as dots where present.
- **Score heatmap** — reuse `goals/Heatmap.tsx` deliberately (it already draws "recorded
  nothing" ≠ "scored zero"). **HabitMatrix** (new) — habit rows × last 30/60 days from
  `habits[].ticks` (window-wide, see §4.2).
- **HabitFelt** — the interesting one. Per habit over *rated* days in the window:
  `mean_with`, `mean_without`, `delta`, `n_with`, `n_without`. Sufficient when
  `rated_days ≥ 20` and both n ≥ 8; rows sorted by |delta| among sufficient rows. Until
  then the tile prints exactly: "N of 20 rated days so far — rate a day on the board or in
  the journal; this answers itself after ~60 days." No bars, no fake zeros.
- **CalendarHours** — per week (2 weeks): hours booked (timed Google events) vs hours worked
  (done tasks: `duration_min ?? est_min ?? event length`), and the area split.
- **GoalsWeek** — goals moved this week with task counts and minutes, unlinked-done count.

### 3.5 Vault split — mechanism now, move later, on Konrad's word
Proposal (asked in manager chat; default if unanswered): two roots, **`Konrad/`** (everything
he writes: `20_Coding`, `30_YouTube`, `10_Idea_Reactor`, `40_Life Knowledge`, the human root
notes, `_Templates`, `Excalidraw`, `Thoughts/`, `Journal/`) and **`Forge/`** (everything an
agent writes: `AI OS`, `90_AI_OS`, `Mentor`, `Daily`, `Inbox` captures, `Thoughts/Seeds`).
Mechanism (`lib/vault-layout.ts` + guard in `lib/vault.ts`): `VAULT_LAYOUT=legacy|split`
(default `legacy`, roots `""`, guard inert — today's writers keep working). Under `split`:
`createNote`/`appendToDailyNote`/`writeVaultFile` take `actor: "agent" | "konrad"`
(default `agent`); agent writes outside `Forge/` are refused with a hard error; `konrad` is
set only by UI-facing routes (thoughts, journal reply, vault editor). Every agent-written
note gets `author: forge` frontmatter. `scripts/vault-split-move.ts` consumes the manifest
from R2, dry-run by default, `--apply` only after Konrad's go. `cc-runner.ts`'s system-prompt
vault paragraph and `agents/*.md` learn the two roots. **No file moves in this project.**

### 3.6 Failure policy (hard errors, nothing swallowed)
Each evidence source and each stats tile fails independently and *visibly*: the API returns
`errors:[{source,message}]` with that field `null`, the UI prints the message in the card.
Vault writes go through `writeVaultFile`'s compare-and-swap + snapshot; a thoughts PATCH
that loses the CAS returns 409 and the UI says so. `queue.add`-style hangs: none — no Redis
here. Nothing retries silently; React Query `retry: 1` on reads, 0 on writes.

**Konrad sees it broke:** the card text; the `GCal offline` chip already on the board; and
the deploy task's screenshots read back into the manager chat.

## 4. Contracts (the web lane builds against these; the reviewer checks both sides quote them)

### 4.1 `GET /api/journal/day?day=YYYY-MM-DD` (extends the existing route in `routes/journal.ts`)
```
{ day,
  mentor:   { verdict: string|null, log_day: string|null, stale_days: number|null,
              metrics: {committed,completed,notes}|null, streak: number,
              last_cron_fired_at: string|null },
  evidence: { tasks_done: [{id,title,area,done_at,goal_id,goal_title}] | null,
              events:     [{id,summary,start,end,minutes,task_id}] | null,   // ended ≤ now, that Berlin day
              commits:    [{repo,sha,subject,at}] | null,                    // /opt/forge-ai-os, /opt/content-forge
              renders:    [{id,title,status,completed_at}] | null,           // content_jobs.render_completed_at in day
              runs:       { chat:n, worker:n, cron:n, items:[{id,title,kind,status,started_at}] } | null,  // items ≤ 20
              decisions:  [{ts,kind,actor,action}] | null,
              habits:     { ticked:[{key,label,icon}], total_active:n } | null,
              glucose:    { readings:n, mean_mgdl:number|null, in_range_pct:number|null } | null,
              score:      { score, habit_pct, task_pct } | null },
  reply:    { subjective: number|null, reflection: string|null, updated_at: string|null,
              note_path: string|null },
  entries:  [ …paper entries exactly as today… ],
  errors:   [ {source, message} ] }
```
`POST /api/journal/:day/reply` `{subjective?: 1..10, reflection?: string}` → `{ok, reply}`.
Owner of state: `day_plans` (`reflect()` in `db/daily.ts`, upsert). Mirror: append to the
layout-aware journal note (`Journal/<day>.md`, `Konrad/Journal/<day>.md` under split).

### 4.2 `GET /api/daily/stats?days=N` — additive fields only
```
habits[].ticks: Day[]                      // window-wide (ticks30 stays)
habit_felt: { rated_days:n, needed:20, sufficient:boolean,
              rows:[{habit_id,key,label,icon,n_with,n_without,mean_with,mean_without,delta,sufficient}] }
goals_week: { week_start, week_end, total_done:n, unlinked_done:n,
              moved:[{goal_id,title,horizon,tasks_done:n,minutes:n}] }
```
`GET /api/daily/stats/calendar?weeks=2` →
`{ weeks:[{week_start,week_end,booked_min,worked_min,events:n,tasks_done:n,
           by_area:[{area,booked_min,worked_min}], error:string|null}] }`
`GET /api/daily/goals` rows gain `tasks_open, tasks_done_30d, minutes_30d, last_moved_at`.
`GET /api/daily/tasks` rows gain `goal_id, suggested_goal_id`; POST/PATCH accept `goal_id`.

### 4.3 `/api/thoughts`
```
GET  /api/thoughts?view=unexecuted|area|importance|executed&area=…
     → { ideas:[{path,idea,area,importance,status,created,age_days,author,source,description,why_genius,sha256}],
         quotes:[{text,source,date}], dreams:[{text,date}], layout:"legacy"|"split" }
POST /api/thoughts/ideas        {idea,area,importance?,description?,why_genius?,status?} → 201 {idea}
PATCH /api/thoughts/ideas       {path, base_sha256, …fields}  → {idea}   (409 on CAS miss)
POST /api/thoughts/ideas/adopt  {path} → {idea}   (moves a Forge seed to Konrad's side)
POST /api/thoughts/quotes       {text,source?} → 201 ;  POST /api/thoughts/dreams {text} → 201
```

## 5. Task graph (workstreams = worktrees; each non-main lane ends in an integration task)

| id | ws | role/tier | what | write_set (owner) |
|---|---|---|---|---|
| T0 | main | builder/junior | land live dirt as one commit + sha manifest | the 33 live paths, `evidence/aios-journal-thoughts-stats/landing-manifest.json` |
| R1 | api-journal | scout/junior | verify every evidence query/command read-only against live | `docs/plan/journal-evidence-sources.md` |
| B1 | api-journal | builder/standard | `/api/journal/day` + `/reply` (§4.1) | `routes/journal.ts`, `db/journal-day.ts`, `lib/evidence/*.ts`, tests |
| B2 | api-daily | builder/standard | 0050 + goal link + stats additions + calendar stats (§4.2) | `db/migrations/0050_*.sql`, `db/daily.ts`, `routes/daily.ts`, `lib/calendar-stats.ts`, tests |
| B3 | thoughts | builder/junior | thoughts store + routes (§4.3) + seed script | `lib/thoughts.ts`, `lib/frontmatter.ts`, `routes/thoughts.ts`, `index.ts`, `scripts/seed-thoughts.ts`, tests |
| R2 | vault | scout/junior | classify the vault; move manifest, no moves | `docs/plan/vault-split-manifest.md` |
| B4 | vault | builder/standard | layout flag + actor guard + move script + prompt/docs (§3.5) | `lib/vault-layout.ts`, `lib/vault.ts`, `scripts/vault-split-move.ts`, `cc-runner.ts`, `agents/*.md`, tests |
| F0 | web | builder/junior | api.ts fetchers + types for §4 | `forge-control-web/app/api.ts` |
| F1 | web | builder/standard | `StatsPanel` + tiles (§3.4) | `forge-control-web/app/desktop/stats/*` |
| F2 | web | builder/standard | JOURNAL rewrite (§3.1) | `JournalSurface.tsx`, `journal/DayEvidence.tsx`, `journal/MentorRead.tsx`, `journal/ReplyBox.tsx`, `journal/JournalRetrospectivePane.tsx` |
| F3 | web | builder/standard | THOUGHTS surface (§3.2) | `nav-items.ts`, `DesktopApp.tsx`, `ThoughtsSurface.tsx`, `thoughts/*` |
| F4 | web | builder/standard | LIFE GOALS drawer + goal link + STATS toggle (§3.3) | `GoalsSurface.tsx`, `goals/LifeGoalsDrawer.tsx`, `goals/TaskDetail.tsx`, `goals/TaskRail.tsx` |
| I1–I5 | main | builder/junior | merge each lane into the project branch; STOP on conflict | union of the lane |
| RV | main | reviewer/standard | one gating review of the whole diff against §4 and gates-808 | — |
| D1 | main | builder/standard | deploy + verify live + screenshots + dry-run seeds/move, ask Konrad | deploy notes, Operator Log |

Rejected alternatives, one line each:
- *Agent-generated "mentor read" on page open* — a paid run per view; the log entry + derived evidence is free and always there.
- *Thoughts in Postgres* — Konrad said "these live in Obsidian"; files with frontmatter are the store, the DB is not a mirror.
- *Auto-link tasks to goals by area* — a silent write on his board; suggestion chip instead.
- *Extend the dead `StatsTab.tsx` in place* — it is unmounted since the week board; extract the primitives, delete nothing yet.
- *One stats endpoint including Google* — a 502 from Google would blank every tile; calendar stats are their own call.
- *Mass-move the vault now* — irreversible, forbidden without his go; flag + dry-run script instead.
- *One workstream, serial* — parallelism is the ruling; five lanes against pinned contracts.
