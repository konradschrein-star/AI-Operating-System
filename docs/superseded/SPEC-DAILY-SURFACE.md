# SPEC — GOALS/TASKS surface (the "Daily" system)

Replaces the `goals` PlaceholderSurface with a real daily operating system:
evening planning, a task manager, habit tracking, and stats that feed back
into the next evening's plan.

## Why it exists (read this — it constrains every decision)

Konrad ran this in Notion and stopped using it. Four causes, all structural:

1. **Blank page every evening.** He had to *create* tomorrow's plan himself.
   Nobody does that at 22:00. → The plan must be DRAFTED FOR HIM by the agent;
   he only accepts or edits. `source: 'agent' | 'konrad'` on goals exists for
   exactly this.
2. **A 20-column checkbox table for habits.** Unusable on a phone; 20 items is
   a wish list, not a habit system. → Habits are TAP-TARGET CHIPS, wrapping,
   one tap to log. Never a wide table.
3. **Task graveyard.** Notion showed "Age: 121 days" and "Time until due: -41"
   on tasks nobody would ever do. Shame metrics with no forcing function.
   → Age is shown only past 14 days, and always next to a one-tap **Drop**.
4. **Dead stats.** Dayscore stuck at 0%, "Current: 0 days" streaks. Read-only,
   never fed back. → Stats are live and the evening planner reads them.

DO NOT reproduce the Notion look. No wide tables of checkboxes. Dark, dense,
terminal-adjacent — match the existing forge-control surfaces exactly.

## Scale changes from Notion (deliberate)

- Importance: Notion had 6 levels (Ultra Important → Insignificant). We use 4:
  `critical | high | normal | low`. Six is decision paralysis.
- Habits: seeded from his real Notion list but collapsed and given weekly
  targets, so "5/7 training" is a pass, not a failure.

---

## 1. Database (Postgres `content_forge`, migration `db/migrations/0042_daily_system.sql`)

All tables prefixed `daily_`. `day` is always a `date` in Europe/Berlin local
terms — the server stores plain `date`, the caller decides the day. Never
compute "today" from UTC in SQL; the API takes a `day` param and defaults it
from `(now() AT TIME ZONE 'Europe/Berlin')::date`.

```sql
CREATE TABLE daily_habits (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  key             text UNIQUE NOT NULL,       -- stable slug, e.g. 'sleep_8h'
  label           text NOT NULL,
  icon            text NOT NULL,              -- material symbol name
  target_per_week int  NOT NULL DEFAULT 7 CHECK (target_per_week BETWEEN 1 AND 7),
  sort            int  NOT NULL DEFAULT 0,
  polarity        text NOT NULL DEFAULT 'do' CHECK (polarity IN ('do','avoid')),
  archived_at     timestamptz,
  created_at      timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE daily_habit_log (
  habit_id  uuid NOT NULL REFERENCES daily_habits(id) ON DELETE CASCADE,
  day       date NOT NULL,
  done      boolean NOT NULL DEFAULT true,
  logged_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (habit_id, day)
);
CREATE INDEX daily_habit_log_day_idx ON daily_habit_log(day);

CREATE TABLE daily_days (
  day         date PRIMARY KEY,
  mood        int CHECK (mood BETWEEN 1 AND 5),
  energy      int CHECK (energy BETWEEN 1 AND 5),
  note        text,          -- Konrad's own line for the day
  plan_note   text,          -- the agent's framing for tomorrow ("why this")
  planned_at  timestamptz,   -- set when the evening planner wrote this day
  reviewed_at timestamptz,   -- set when Konrad closed the day out
  created_at  timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE daily_goals (
  id         uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  day        date NOT NULL,
  title      text NOT NULL,
  detail     text,
  status     text NOT NULL DEFAULT 'open'
             CHECK (status IN ('open','done','dropped','carried')),
  source     text NOT NULL DEFAULT 'konrad' CHECK (source IN ('agent','konrad')),
  sort       int  NOT NULL DEFAULT 0,
  created_at timestamptz NOT NULL DEFAULT now(),
  done_at    timestamptz
);
CREATE INDEX daily_goals_day_idx ON daily_goals(day);

CREATE TABLE daily_tasks (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  title        text NOT NULL,
  notes        text,
  area         text NOT NULL DEFAULT 'personal'
               CHECK (area IN ('uni','business','content','health','admin','personal')),
  importance   text NOT NULL DEFAULT 'normal'
               CHECK (importance IN ('critical','high','normal','low')),
  status       text NOT NULL DEFAULT 'todo'
               CHECK (status IN ('todo','doing','blocked','done','dropped')),
  due          date,
  planned_day  date,          -- the day it is scheduled onto. NULL = backlog.
  estimate_min int,
  sort         int NOT NULL DEFAULT 0,
  created_at   timestamptz NOT NULL DEFAULT now(),
  done_at      timestamptz,
  dropped_at   timestamptz
);
CREATE INDEX daily_tasks_planned_idx ON daily_tasks(planned_day) WHERE status IN ('todo','doing','blocked');
CREATE INDEX daily_tasks_status_idx  ON daily_tasks(status);
```

Seed 14 habits (idempotent `ON CONFLICT (key) DO NOTHING`), taken from his real
Notion list, with sensible weekly targets and material-symbol icons:

| key | label | icon | target | polarity |
|---|---|---|---|---|
| wake_early | Wake up 6:00 | alarm | 5 | do |
| sleep_8h | 8h sleep | bedtime | 6 | do |
| journal | Journaling | edit_note | 7 | do |
| meditate | Meditation 5 min | self_improvement | 5 | do |
| stretch | Stretching | accessibility_new | 5 | do |
| train | Trained | fitness_center | 4 | do |
| clean_diet | Clean diet | restaurant | 6 | do |
| no_sweets | No sweets | no_food | 5 | avoid |
| supplements | Supplements | medication | 7 | do |
| read_20 | Read 20 min | menu_book | 5 | do |
| deep_work | Done enough work | bolt | 5 | do |
| shipped | Shipped / uploaded | rocket_launch | 3 | do |
| chores | Chores done | checklist | 5 | do |
| screen_limit | Screen time < 30m | phonelink_erase | 5 | avoid |

## 2. Day score (one definition, server-side only)

```
habitPart = habits_done_today / max(1, active_habits)
goalPart  = goals_done_today  / max(1, goals_today)     -- 0 when no goals set
score     = round(100 * (goals_today > 0 ? 0.5*habitPart + 0.5*goalPart
                                         : habitPart))
```
Computed in the db module, never in React. The number must be identical on
TODAY, in STATS, and in the heatmap.

## 3. API (`forge-control/src/routes/daily.ts`, mounted `app.route("/api/daily", daily)`)

DB access in `forge-control/src/db/daily.ts`, using the SAME private-`Pool`
pattern as `src/db/autonomy.ts` (`DATABASE_URL`, content_forge). Follow the
Hono style of `routes/autonomy.ts`: validate at the edge, return `{error}` +
4xx on bad input, never throw a raw pg error to the wire.

```
GET  /api/daily/today?day=YYYY-MM-DD
       -> { day, score, goals[], tasks[], habits[] (each with done:boolean),
            meta: { mood, energy, note, plan_note, planned_at, reviewed_at },
            carried: number   // open tasks planned for an earlier day }
GET  /api/daily/tasks?status=&area=&importance=&planned=today|backlog|all&limit=
       -> { tasks[] }  // ordered: importance desc, due nulls last, created asc
POST /api/daily/tasks            { title, area?, importance?, due?, planned_day?, notes?, estimate_min? } -> { task }
PATCH /api/daily/tasks/:id       any subset of the above + status -> { task }
       // setting status=done stamps done_at; dropped stamps dropped_at; back to todo clears both
DELETE /api/daily/tasks/:id      -> { deleted:true }        // hard delete only for typos
POST /api/daily/goals            { day?, title, detail?, source? } -> { goal }
PATCH /api/daily/goals/:id       { title?, detail?, status?, sort? } -> { goal }
DELETE /api/daily/goals/:id      -> { deleted:true }
POST /api/daily/habits/:id/toggle { day? } -> { habit_id, day, done }   // idempotent flip
GET  /api/daily/habits           -> { habits[] } (active, sorted)
PATCH /api/daily/day             { day?, mood?, energy?, note? } -> { meta }
GET  /api/daily/stats?days=56
       -> { heatmap: [{day, score, habits_done, goals_done, tasks_done}],
            habits: [{id,key,label,icon,polarity,target_per_week,
                      current_streak, longest_streak, last_7, last_30, rate_30}],
            tasks:  { done_last_7, done_last_30, by_area: [{area,count}],
                      open_total, backlog_older_14d },
            score:  { today, avg_7, avg_30, best_day } }
POST /api/daily/plan             { day?, goals:[{title,detail?}], task_ids?:uuid[],
                                   plan_note?, source?:'agent' }
       // The evening planner's single write: replaces the target day's
       // agent-sourced goals, sets planned_day on the listed tasks, stamps
       // planned_at. Konrad-sourced goals are NEVER touched. -> { day, goals, tasks }
```

`current_streak`: consecutive days ending today (or yesterday, if today is not
yet logged — a streak must not read as broken before the day is over) on which
the habit was done. For `polarity='avoid'` the semantics are identical (logging
it = "I held the line today").

## 4. Frontend (`forge-control-web/app/desktop/GoalsSurface.tsx`)

Client fns go in `app/api.ts` next to the existing ones (`getJson`/`postJson`/
`patchJson` helpers already exist). Styling: inline styles from `app/tokens.ts`
ONLY — no Tailwind, no CSS modules. Copy the structural idiom of
`AutonomySurface.tsx` (react-query, `useMutation` + `invalidateQueries`).
Icons: the app already loads Material Symbols — use `<span className="material-symbols-outlined">`
if that is how existing surfaces do it; otherwise match whatever they do.

### Nav rename
In `app/desktop/nav-items.ts`, the `goals` NavItem label becomes
`"GOALS/TASKS"`. The key stays `"goals"` (persisted state + checks depend on
it). In `DesktopApp.tsx`, add `{surface === "goals" && <GoalsSurface />}` next
to the other real surfaces and REMOVE the `goals` entry from
`PLACEHOLDER_SURFACES`.

### Three tabs, one sticky segmented control: TODAY · PLAN · STATS

**TODAY** (the default, and the only screen that matters on a phone)
- Header row: weekday + date, and a **score ring** (SVG donut, accent-coloured,
  the % in the middle). Under it: `3/5 habits · 1/3 focus`.
- **FOCUS** — up to 3 goal cards. Big tap target, title + optional detail, a
  check circle on the left. Done = struck through + faded, not removed. Agent-
  written goals carry a small `AGENT` tag so he can see the system worked.
  A `+` adds his own. If the day has no goals: an empty state with a **"Draft
  my day"** button (POSTs nothing yet — just deep-links to CHAT with a
  pre-filled prompt, or shows the copy "the evening planner runs at 21:00").
- **TODAY'S TASKS** — tasks with `planned_day = today`, plus a distinct
  **CARRIED** group above for open tasks planned for an earlier day (with their
  original day shown). Row: checkbox · importance dot · title · area chip ·
  optional due. Tapping the row body opens an inline edit; tapping the checkbox
  completes. Quick-add input pinned at the bottom of the block: type + Enter
  creates a task planned for today.
- **HABITS** — a wrapping grid of chips, each ~72px: icon on top, short label
  under. Untoggled = `bgCard` + `borderSoft` + `textMuted`. Toggled = accent
  border, accent icon, filled `primaryActionBg`. `polarity='avoid'` chips use
  `warn` when toggled instead of accent, so "held the line" reads differently
  from "did the thing". Optimistic update — a tap must feel instant.
- **CHECK-OUT** — mood + energy as two rows of 5 dots, and a one-line note.

**PLAN** (the task manager — this replaces the Notion Task Database)
- Filter bar: area chips, importance chips, status chips, plus a
  `list | board` view toggle. Filters are AND-ed, all optional.
- **List view**: grouped by planned/backlog. Dense rows, 32px tall, importance
  as a coloured left border (`critical`=bleed, `high`=warn, `normal`=info,
  `low`=textFaint). Right side: age badge ONLY when older than 14 days, next to
  a **Drop** action.
- **Board view**: four columns (todo / doing / blocked / done-today). Column
  header shows count. Moving a card = a status PATCH; use buttons, not HTML5
  drag (drag is unusable on the phone he actually opens this on).
- Row actions: `Today`, `Tomorrow`, `Done`, `Drop`.
- Add form: title, area, importance, due, estimate.

**STATS** (the part of Notion he actually liked, done properly)
- **Heatmap**: 8 weeks × 7 days of day-score squares, GitHub-style, 5 intensity
  steps of the accent colour. Column = week, row = weekday. Hover/tap shows
  day + score + counts. Horizontally scrollable at phone width.
- **Score tiles**: today · 7-day avg · 30-day avg · best day.
- **Habit cards**: one per habit — icon, label, current streak (flame + n),
  longest, a 7-dot last-week strip, and a 30-day rate bar with the weekly
  target marked so under-target is visible at a glance.
- **Task stats**: done last 7 / last 30, a small per-area bar list with area
  icons, open total, and "N older than 14 days" as a call to triage.

### Mobile (this is non-negotiable — he checks this on a phone in bed)
- Single column below 700px. The segmented control is sticky at the top.
- Every tap target ≥ 44px. Habit chips wrap to 4 per row at 390px.
- No horizontal scroll anywhere except the heatmap, which scrolls on purpose.
- The board's four columns become a horizontal snap-scroll carousel.

## Definition of done
- `npx tsc --noEmit` clean in both packages (use the repo's existing check).
- Migration applies to content_forge and re-applies without error.
- Every endpoint above answers correctly against real rows.
- No `any` on exported types; no console noise on mount.
