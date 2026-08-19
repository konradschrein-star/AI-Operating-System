# Spec — GOALS/TASKS surface (Daily goals, task planner, habits, stats)

*Konrad, 2026-08-19. Replaces the `goals` placeholder in DesktopApp's
`PLACEHOLDER_SURFACES`. Supersedes his dead Notion setup.*

## 0. Why this exists and why Notion failed

He ran a Notion "Taskmanager" (task DB: Name / Age / Time-until-due / Area /
Status / Importance / Due / Creation) plus a "self-improvement daily page" (a
table of ~19 habit checkbox columns per day, a Dayscore %, a subjective
rating, streak rollups, a booklist and a goals table). He stopped using it.

The failure modes, named so we do not rebuild them:

1. **Blank page every evening.** Nothing wrote the plan; he had to. So he didn't.
2. **A task graveyard.** Rows with `Age 121` and `Time until due -41` sat
   forever. Nothing forced a decision.
3. **A 19-column checkbox wall.** Unusable on a phone, which is where the
   habits actually get ticked.
4. **Passive stats.** `Current: 0 days / Longest: 5 days / 0%` — accurate,
   inert. Nothing acted on them.

## 1. The spine — said vs done

From `Mentor/Profile/Principles & Beliefs.md`:

> **Said vs done is the only scoreboard.** Morning commitment vs night
> checkbox; everything else is narrative.

> **Guilt-free rest is earned by the to-do list.** Fulfil the day → sleep
> well → enjoy without guilt.

The whole surface is that loop, made mechanical:

```
  EVENING (~20:30, operator-written)   the plan is drafted FOR him from real
                                       context: open tasks, calendar, projects,
                                       today's daily note. He never faces a
                                       blank page.
  MORNING (he taps COMMIT)             the Big 3 freeze. This is "said".
  ALL DAY                              tick tasks + habits. This is "done".
  NIGHT                                day score + a one-tap subjective rating.
```

**The freeze is the product.** Once committed, the day's Big 3 text is
immutable — you may complete or explicitly ABANDON a goal (recorded as
abandoned, with a reason), but you may not quietly rewrite it to match what you
happened to do. Notion let him move the goalposts silently; that is why the
stats meant nothing. Editing before commit is free.

## 2. Data model — `db/migrations/0042_daily_goals.sql`

Database: **content_forge** (`DATABASE_URL`), same as `reminders`, `runs`,
`ui_dismissals`. Every statement idempotent (`IF NOT EXISTS`) —
`forge-control/src/lib/migrations.test.ts` asserts re-runnability.

```sql
-- day_plans: one row per calendar day.
day_plans (
  day            date PRIMARY KEY,
  big3           jsonb  NOT NULL DEFAULT '[]'::jsonb,
     -- [{id, text, why, status:'open'|'done'|'abandoned', reason, done_at}]
     -- max 3 entries, enforced in the route not the DB.
  intent         text,            -- one line: what today is FOR
  committed_at   timestamptz,     -- NULL = still editable draft
  generated_by   text,            -- 'operator' | 'konrad'
  generated_at   timestamptz,
  subjective     smallint,        -- 1..5, his night rating
  reflection     text,            -- optional free line at night
  created_at     timestamptz NOT NULL DEFAULT now(),
  updated_at     timestamptz NOT NULL DEFAULT now()
)

-- habits: the definitions. Editable; seeded from his Notion list.
habits (
  id         uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  key        text UNIQUE NOT NULL,      -- stable slug, survives relabelling
  label      text NOT NULL,
  icon       text NOT NULL,             -- Material Symbols name
  grp        text NOT NULL,             -- 'morning'|'body'|'work'|'evening'
  polarity   text NOT NULL DEFAULT 'do',-- 'do' | 'avoid'  (avoid = "No sweets")
  weight     smallint NOT NULL DEFAULT 1,
  sort       smallint NOT NULL DEFAULT 0,
  active     boolean NOT NULL DEFAULT true,
  created_at timestamptz NOT NULL DEFAULT now()
)

-- habit_logs: the ticks. Absent row = not done.
habit_logs (
  day      date NOT NULL,
  habit_id uuid NOT NULL REFERENCES habits(id) ON DELETE CASCADE,
  done     boolean NOT NULL DEFAULT true,
  ts       timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (day, habit_id)
)

-- day_tasks: the task planner. NOT the coding-project `tasks` table.
day_tasks (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  title        text NOT NULL,
  area         text,                       -- 'uni'|'business'|'health'|...  free text
  importance   smallint NOT NULL DEFAULT 2,-- 3 critical / 2 high / 1 normal / 0 low
  status       text NOT NULL DEFAULT 'todo', -- todo|doing|done|parked
  planned_day  date,                       -- the day it is scheduled ON
  due_day      date,                       -- the day it is due BY (optional)
  est_min      smallint,                   -- rough estimate, for load warning
  carried      smallint NOT NULL DEFAULT 0,-- times rolled to a new day
  notes        text,
  done_at      timestamptz,
  created_at   timestamptz NOT NULL DEFAULT now(),
  updated_at   timestamptz NOT NULL DEFAULT now()
)
CREATE INDEX IF NOT EXISTS day_tasks_planned_idx ON day_tasks(planned_day)
  WHERE status <> 'done';
CREATE INDEX IF NOT EXISTS day_tasks_status_idx  ON day_tasks(status);
```

Seed habits (INSERT ... ON CONFLICT (key) DO NOTHING), from his Notion columns,
grouped so a phone shows four short rows instead of one 19-wide table:

| grp | key | label | icon | polarity |
|---|---|---|---|---|
| morning | wake_6 | Woke up 6:00 | alarm | do |
| morning | sleep_8h | 8h sleep | bedtime | do |
| morning | journaling | Journaling | edit_note | do |
| morning | meditation | Meditation 5 min | self_improvement | do |
| morning | breakfast | Healthy breakfast | egg_alt | do |
| morning | supplements | Supplements | medication | do |
| body | stretching | Stretching | accessibility_new | do |
| body | trained | Trained | fitness_center | do |
| body | clean_diet | Clean diet | restaurant | do |
| body | no_sweets | No sweets | no_food | avoid |
| work | deep_work | Done enough work | bolt | do |
| work | shipped | Shipped / uploaded | rocket_launch | do |
| work | chores | All chores done | checklist | do |
| work | screen_time | Screen time < 30 min | phone_iphone | avoid |
| evening | read_20 | Read 20 mins | menu_book | do |
| evening | face | Cleaned face | face_retouching_natural | do |
| evening | teeth | Brushed teeth | dentistry | do |
| evening | plan_tomorrow | Reviewed tomorrow's plan | event_upcoming | do |

`weight`: `sleep_8h`, `trained`, `deep_work`, `shipped` get `weight 2` — they
are the ones that actually move his year. Everything else 1.

## 3. Scoring — one honest formula, in ONE place

`forge-control/src/lib/day-score.ts`, pure, unit-tested. Nothing else may
compute a score.

```
habit_pct = Σ weight(done habits) / Σ weight(active habits)
goal_pct  = done big3 / committed big3        (abandoned counts as NOT done)
task_pct  = done tasks planned for the day / tasks planned for the day
day_score = round(100 * (0.45*goal_pct + 0.35*habit_pct + 0.20*task_pct))
```

Rules that matter:
- A component with **no denominator is dropped and the remaining weights
  renormalise.** No Big 3 committed → the day is scored on habits and tasks
  alone. Never divide by zero, never silently score a missing component as 0 —
  that is how Notion produced a permanent, meaningless `0%`.
- Goals dominate deliberately. Ticking eighteen habits while missing all three
  stated goals is **not** a good day, and the number must say so.
- `day_score >= 80` → the UI prints **"Day fulfilled — rest guilt-free."**
  That sentence is his, from Principles & Beliefs. It is the reward.
- Today's score is provisional until the day ends; label it so.

## 4. API — `forge-control/src/routes/daily.ts`, mounted at `/api/daily`

Follow `routes/autonomy.ts` for shape: thin Hono routes, all SQL in
`src/db/daily.ts` with a module-local `pg.Pool` on `DATABASE_URL` (copy the
pool preamble from `src/db/reminders.ts`).

```
GET    /api/daily?day=YYYY-MM-DD      -> { day, plan, habits[], ticks[], tasks[], score }
                                         day defaults to today (Europe/Berlin).
POST   /api/daily/:day/plan           { intent?, big3? }  draft edit; 409 if committed
POST   /api/daily/:day/commit         freezes big3, sets committed_at. Idempotent.
POST   /api/daily/:day/goal/:goalId   { status:'done'|'open'|'abandoned', reason? }
POST   /api/daily/:day/reflect        { subjective?:1..5, reflection? }
POST   /api/daily/:day/habit/:habitId { done: boolean }   upsert / delete-on-false

GET    /api/daily/tasks?view=today|week|backlog|all&area=&status=
POST   /api/daily/tasks               { title, area?, importance?, planned_day?, due_day?, est_min?, notes? }
PATCH  /api/daily/tasks/:id           any of the above + status
DELETE /api/daily/tasks/:id
POST   /api/daily/rollover            { to?: day }  idempotent; see §5

GET    /api/daily/stats?days=90       -> { days:[{day,score,habit_pct,goal_pct,task_pct,subjective}],
                                           habits:[{key,label,icon,grp,rate30,streak,best}],
                                           said_vs_done:{committed,done,abandoned,rate},
                                           tasks:{done_by_day:[{day,n}], open, stale},
                                           streak:{current,best} }

GET    /api/daily/habits              habit definitions
POST   /api/daily/habits              create   { key,label,icon,grp,polarity?,weight?,sort? }
PATCH  /api/daily/habits/:id          edit / deactivate (never DELETE — history)
```

Validation: max 3 Big 3 entries (400 beyond that); `importance` 0..3;
`subjective` 1..5; `status` from the enum; title ≤ 300 chars. Reject with a
message that says what was wrong, not `{"error":"bad request"}`.

`streak` for a habit = consecutive days ending yesterday-or-today with a tick.
Today counts only if ticked; an unticked today does not break the streak (the
day is not over). Deliberate — Notion's `Current: 0 days` was demoralising and
wrong at 09:00.

## 5. Rollover — the anti-graveyard mechanism

`POST /api/daily/rollover` moves every `status IN ('todo','doing')` task whose
`planned_day < today` onto today and increments `carried`. Idempotent per day.

`carried >= 3` makes the task **stale**. Stale tasks render at the top of
TODAY in a boxed "This keeps sliding — do it or kill it" strip with exactly two
buttons: **Do it today** (pin, resets carried to 0) and **Kill it**
(status `parked`). No third option. This is the direct answer to
`Age 121 / Time until due -41`, and to *"DO NOT BULLSHIT YOURSELF."*

The executor calls rollover at the start of the evening plan job (§7).

## 6. UI — `forge-control-web/app/desktop/GoalsSurface.tsx`

Nav: in `app/desktop/nav-items.ts`, the `goals` item's label becomes
`"GOALS/TASKS"`. Key stays `"goals"` — it is persisted in localStorage and
asserted by `scripts/checks/check-r1873-fixes.ts`. Remove the `goals` entry
from `PLACEHOLDER_SURFACES` in `DesktopApp.tsx` and render
`{surface === "goals" && <GoalsSurface />}` next to the other real surfaces.

Style: **match the existing surfaces exactly** — inline `CSSProperties`, every
colour from `app/tokens.ts`, Material Symbols icon names, `@tanstack/react-query`
for fetching, mutations invalidating `["daily"]` / `["daily-stats"]`. Do not
introduce Tailwind, a component library, or a new colour.

Three tabs — `TODAY` · `TASKS` · `STATS`. On a phone they are the primary
navigation; at desktop width TODAY may show TASKS beside it in a second column.
**Test at 390px first.** Every tap target ≥ 40px. No horizontal scrolling of a
table, ever — that is the single worst thing Notion did to him.

### TODAY
1. **Header** — weekday + date, and the score as a compact ring with the number
   inside. Under it: the intent line. If uncommitted, a full-width
   **COMMIT THE DAY** button; the ring is muted grey until then.
2. **Stale strip** (only when stale tasks exist) — §5.
3. **THE BIG 3** — three cards. Large tap-to-complete circle, goal text, the
   `why` in muted small type. A completed card gets the accent tick and strikes
   through. A long-press / `⋯` offers **Abandon** with a one-line reason. After
   commit the text is not an input any more — it is text. Show the lock icon
   and the tooltip "committed at 08:12 — abandon instead of editing".
4. **HABITS** — four labelled rows (Morning / Body / Work / Evening) of icon
   chips. A chip is icon + short label, ~64px, tap toggles with an immediate
   optimistic flip. Done = accent border + filled icon. `avoid` habits show
   their icon struck through when successfully avoided. A small streak number
   sits in the chip's corner when streak ≥ 3.
5. **TODAY'S TASKS** — compact rows: checkbox · title · area chip · importance
   dot. Tap the row to expand for notes/due/estimate. Inline one-line quick-add
   at the bottom that parses `#area`, `!!` (critical) / `!` (high), `~30m`, and
   `tomorrow` / `mon` out of the text — the rest is the title.
6. **NIGHT** — appears after 20:00 local: the 1..5 subjective rating as five
   taps, an optional reflection line, and either "Day fulfilled — rest
   guilt-free." at ≥ 80 or the honest number.

### TASKS
One list, four view chips: **Today / Week / Backlog / All**, plus an area
filter row and a status filter. Rows sort by importance then due. Show `age`
(days since creation) and `carried` only when they are bad news — age > 14 or
carried ≥ 2 — as a small warning-coloured chip. Never a permanent shame column.
Board view (`todo | doing | done | parked` columns) at ≥ 900px only; on a phone
the view chips are the board.

### STATS
This is what he liked about Notion; make it the part that is better.
1. **Said vs done** — the headline. A big percentage: of the goals he committed
   to over the window, how many he did. Plus the raw counts and the abandon
   count. Nothing else on the surface matters as much.
2. **Heatmap** — last 90 days, day score, GitHub-style, week columns, five
   intensity steps built from `tokens.accent` at increasing opacity. Tap a cell
   → that day's summary in a sheet. Must fit 390px without scrolling
   horizontally (cells shrink; 13 weeks on a phone, 90 days at desktop).
3. **Habit table** — one row per habit: icon, label, a 30-day sparkline of
   ticks, `rate30` as a bar, current streak, best streak. Sortable by rate so
   the weak ones surface. This is the icon-and-table view he explicitly asked
   to keep.
4. **Output** — tasks completed per day for the window as small bars, with the
   7-day average called out.
5. **Score trend** — day score as a line, 7-day moving average over it.

Empty states everywhere state what will fill them, e.g. "No plan yet — the
evening job writes tomorrow's Big 3 at 20:30, or write them yourself."

## 7. The evening job (backend agent: set up, do not skip)

Create a reminder-driven operator job so the plan writes itself:

```
POST http://127.0.0.1:7700/api/reminders
{ "text": "Evening plan: call POST /api/daily/rollover, then read today's
   Daily note, open day_tasks and the calendar, and write tomorrow's intent +
   Big 3 + planned tasks via POST /api/daily/<tomorrow>/plan. Leave it
   UNCOMMITTED — Konrad commits it in the morning.",
  "when": "daily 20:30" }
{ "text": "Morning: open GOALS/TASKS and commit the day.", "when": "daily 08:00" }
```

Keep each under 500 chars (longer is rejected 400).

## 8. Verification — required, not optional

Backend: `curl` every endpoint against the running service on :7700 and paste
real responses into the report. Unit-test `day-score.ts` (renormalisation, the
no-Big-3 case, abandoned counting as not-done) and the quick-add parser if it
lands server-side. `cd /opt/forge-ai-os/forge-control && npx tsc --noEmit -p
tsconfig.json` must pass.

Frontend: `cd /opt/forge-ai-os/forge-control-web && npx tsc --noEmit` must pass.
Do **not** run `next build` or restart pm2 — the operator rebuilds via
`/opt/ai-os/scripts/rebuild-web.sh`, which holds a lock. Two concurrent builds
delete each other's artifacts.

Never restart `forge-executor`.
