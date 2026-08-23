# PLAN — aios-today-and-inbox

Project d072b4f8 · branch project/d072b4f8 · architect round 0 · 2026-08-23

## 0. Recommendation, in one paragraph

Redesign `TodaySurface` and `InboxSurface` to replace empty voids with high-density, actionable operator interfaces grounded strictly in real data. `TodaySurface` becomes the unified **Operator Morning Briefing & Day-Driver**: embedding the daily commitment loop from `/api/daily` (Big 3 goals with morning freeze lock, intent editor, 4-row habit execution strip, and stale task rollover banner) alongside real-time operational telemetry (pipeline mini funnel, Hermes fleet pulse with proper status dots, metered cash spend vs €50 cap with flat-rate Claude shadow pricing excluded, and 1-click actionable inbox triage). `InboxSurface` becomes a fast, keyboard-first triage workstation: fixing the `/api/proxy` double-prefix 404 bug on video playback and scene thumbnails, adding 10s auto-refresh polling, replacing the 75% black abyss on Inbox Zero with an Executive System Pulse dashboard, supporting keyboard shortcuts (`j`/`k`, `a` approve, `d` deny, `e` done, `/` search), preserving selection index during triage, and introducing segmented filtering with full resolution audit history.

Rejected alternatives (one line each):
- Embedding the full historical task backlog and 90-day charts directly on Today: rejected because Today is an active execution cockpit, not a backlog database (Tasks surface owns deep planning).
- Merging Inbox completely into Today: rejected because Today requires quick triage cards, while Inbox is a dedicated deep-review workstation with HTML5 video player, scene scrubbers, and resolution audit logs.
- Mocking or inventing numbers when backend data is zero: rejected because hard rules prohibit fake data; an honest "0 in pipeline" or "inbox zero" is the core purpose of the OS.
- Concurrent multi-workstream file writes: rejected because discrete single-workstream dependencies prevent merge conflicts and lock contention.

---

## 1. System Architecture & Invariants

### What Owns State
- **Financial Telemetry:** PostgreSQL `spend_log` table. Real metered spend is aggregated with `WHERE provider <> 'claude-code' AND created_at >= date_trunc('day', now() AT TIME ZONE 'UTC')`.
- **Daily Commitment & Habits:** PostgreSQL `daily_plans` (`big3` jsonb, `intent`, `committed_at`, `subjective`, `reflection`), `daily_habits`, `daily_habit_ticks`, and `daily_tasks`.
- **System Exceptions & Triage:** PostgreSQL `inbox_items` (`status` in `BLEED`, `STUCK`, `APPROVE`, `DECIDE`, `REMINDER`, `NORMAL`), `content_jobs` for linked video QC previews, and `decisions`.
- **Fleet State:** Hermes database & runtime heartbeats (`listWorkers()`, `latestHeartbeatPerWorker()`).
- **Pipeline Metrics:** PostgreSQL `content_jobs` status rollups (`IDEA`, `SCRIPT`, `RENDERING`, `PUBLISHED`, etc.).
- **Client Cache & View State:** React Query caches (`["today"]`, `["daily", "day", dayKey]`, `["inbox", status]`, `["inbox-preview", id]`), local filter selection, keyboard focus, and adjacent item selection tracking.

### What Dispatches Work
- **Today Morning Gate:** `commitDay(day, { intent, big3 })` calls `POST /api/daily/:day/commit`, permanently freezing the Big 3 into an immutable Said vs Done contract.
- **Habit Ticks:** `setDayHabit(day, habitKey, next)` optimistically toggles habit completion via `POST /api/daily/:day/habit/:habitKey`.
- **Stale Task Rollover:** "Do it today" pins task to current day and resets carry count (`POST /api/daily/tasks/:id/pin`); "Kill it" marks task parked (`PATCH /api/daily/tasks/:id`).
- **Direct Inbox Actions:** 1-click Approve / Deny / Resolve on Today calls `POST /api/inbox/:id/resolve` without forcing full navigation.
- **Inbox Keyboard & Triage Actions:** Pressing `a` (Approve), `d` (Deny with reason prompt), or `e` (Done) sends `POST /api/inbox/:id/resolve`, smoothly advancing cursor to the next adjacent item.

### What Happens on Failure
- **Loading:** Container geometry is preserved using muted pulse skeleton cards; no jumping layouts.
- **Network / Route Errors:** Renders `ErrorPanel` with exact error details and retry affordances; never silently swallows errors or falls back to fake states.
- **Empty States:** Explanatory zero states detailing why data is absent (e.g. "Inbox zero — autonomous loops normal", "No active tasks carried ≥3x").
- **Optimistic Mutations:** On network failure, React Query automatically rolls back client state and triggers `toastError()`.

### How Konrad Sees It Broke
- **Fleet Pulse:** Idle workers display muted gray dots (`tokens.textMuted`), active workers show pulsing green (`tokens.ok`), stuck workers show purple (`tokens.stuck`), and bleed shows red (`tokens.bleed`).
- **Spend Meter:** Shows metered EUR against €50 budget cap; turns amber at >75% and red at >100%.
- **Stale Tasks:** Prominent amber warning banner appears when tasks have been carried 3 or more days.
- **Inbox Media:** Video player and scene thumbnails stream cleanly from `/api/proxy/media/...` without 404s.

---

## 2. Detailed Surface Specifications

### A. Today Surface (`TodaySurface.tsx`)
1. **Top Briefing Bar:**
   - Dynamic greeting ("Good morning, Konrad." / "Working late, Konrad.") + formatted date ("Sunday, 23 August 2026").
   - Live Said vs Done Score Ring (displaying server score percentage, provisionally calculated prior to night reflection).
2. **Morning Line Chips:**
   - `[ COMMIT DAY ]`: Amber pulse if uncommitted (scrolls to Big 3); green checkmark if committed.
   - `[ N in pipeline ]` -> jumps to `pipeline`.
   - `[ N stuck ]` / `[ N bleed ]` -> jumps to `inbox` / `live` with alert badges.
   - `[ €X.XX / €50 spend ]` -> jumps to `money` (shows metered cash burn).
3. **Stale Tasks Anti-Graveyard Banner:**
   - Surfaces tasks carried >= 3 days. Binary quick actions: `[ Do it today (Pin) ]` or `[ Kill it (Park) ]`.
4. **The Big 3 Commitment Block (Morning Gate):**
   - Editable Intent input + 3 Big 3 draft goal slots populated by the overnight operator AI.
   - Prominent `COMMIT THE DAY` primary button that locks goals and records `committed_at`.
   - Post-commit: goals lock into interactive tap-to-complete checkboxes with reason-demanded Abandon option.
5. **Two-Column Operational Cockpit (1.4fr : 1fr):**
   - **Left Column:**
     - *Pipeline Funnel:* Visual stage pills (`Idea` -> `Script` -> `Render` -> `Ready`) showing real job counts.
     - *Fleet Pulse:* Hermes worker list with accurate status dots (gray for idle, green for active, purple for stuck). Clicking any worker navigates to Chat with `/watch <worker>`.
   - **Right Column:**
     - *Actionable Inbox:* Stream of open high-priority triage cards with inline Approve / Deny / Resolve buttons.
     - When empty: renders clean "Inbox zero — autonomous loops normal" status card.
6. **Habit Execution Strip:**
   - 4 compact horizontal rows of habit chips (Morning, Body, Work, Evening) with optimistic toggling.
7. **Overnight Machine Diary (Collapsible):**
   - Summary card showing overnight agent runs, spend breakdown, and system health.

### B. Inbox Surface (`InboxSurface.tsx`)
1. **Media Proxy Fix:**
   - Corrects media URLs to `/api/proxy/media/job/:jobId/final.mp4` and `/api/proxy/media/job/:jobId/asset/:thumb` ensuring HTML5 video player and scene thumbnails load without 404 errors.
2. **Auto-Polling & Query Freshness:**
   - Configures `refetchInterval: 10_000` (10s) on inbox queries so desktop never goes stale.
3. **Executive System Pulse on Inbox Zero:**
   - Replaces the 75% black void with an Executive System Pulse dashboard:
     - All-clear status badge ("Inbox Zero · Autonomous Systems Healthy").
     - Fleet summary (active/idle count, zero circuit breaker trips).
     - Today's triage statistics (number of decisions handled today).
     - Upcoming scheduled reminders queue.
     - Quick action buttons (View History, Create Reminder, Open Chat).
4. **Keyboard Navigation & Shortcuts:**
   - `j` / `k` or `ArrowDown` / `ArrowUp` to navigate list.
   - `a` to Approve selected item.
   - `d` to open Deny textarea with autofocus.
   - `e` to Mark Done / Resolve.
   - `/` to focus search filter.
   - `r` to manually trigger refetch.
   - Keyboard hint footer at bottom of rail.
5. **Selection Preservation:**
   - When resolving an item, calculates adjacent index `Math.min(currentIndex, nextItems.length - 1)` so focus smoothly steps through the queue rather than resetting to `items[0]`.
6. **Segmented Filter Tabs & History:**
   - Filter tabs: `All (N)` | `Urgent (N)` | `QC (N)` | `Reminders (N)` | `History (Resolved)`.
   - History view renders resolved items with timestamp, resolved_by, and decision payload.

---

## 3. Implementation Tasks & Scheduling Graph

```
[Task 1: Backend Builder]
         │
         ▼
[Task 2: Today Builder]
         │
         ▼
[Task 3: Inbox Builder]
         │
         ▼
[Task 4: Reviewer & Verification]
```

### Task 1: Backend Endpoints, Spend Rollup Fix & Resolved History
- **Role:** `builder`
- **Tier:** `junior` (Sonnet)
- **Workstream:** `main`
- **Depends On:** `[]`
- **Write Set:**
  - `forge-control/src/routes/today.ts`
  - `forge-control/src/routes/inbox.ts`
  - `forge-control/src/db/spend.ts`
  - `forge-control/src/db/ai_os.ts`
  - `forge-control-web/app/api.ts`
- **Deliverables:**
  - Fix `todaySpendRollup` in `db/spend.ts` to exclude `claude-code` (`WHERE provider <> 'claude-code'`).
  - Fix worker status mapping in `routes/today.ts` so running workers report their active status instead of being forced to `"idle"`.
  - Add `?status=open|resolved|all` support to `routes/inbox.ts` and implement `listResolvedInbox()` in `db/ai_os.ts`.
  - Ensure `getInboxItemPreview` in `db/ai_os.ts` generates clean `/media/job/...` URLs.
  - Update `forge-control-web/app/api.ts` with updated types and functions for inbox status filtering.

### Task 2: Redesign TodaySurface (Executive Day-Driver & Operator Cockpit)
- **Role:** `builder`
- **Tier:** `standard` (Opus)
- **Workstream:** `main`
- **Depends On:** `[Task 1]`
- **Write Set:**
  - `forge-control-web/app/desktop/TodaySurface.tsx`
- **Deliverables:**
  - Complete redesign of `TodaySurface.tsx` incorporating:
    - Top briefing bar with greeting, date, and Said vs Done score ring.
    - Morning line filter chips (`COMMIT DAY`, pipeline count, stuck/bleed alerts, metered spend vs €50 cap).
    - Stale task warning banner (carried >= 3) with Pin and Park actions.
    - Big 3 Commitment Block with intent editor and `COMMIT THE DAY` lock button.
    - Two-column operational grid: Pipeline mini funnel + interactive Fleet pulse (with accurate dot colors and click to `/watch`), plus Actionable Inbox triage cards.
    - 4-row compact habit execution strip with optimistic updates.
    - Collapsible Overnight Machine Diary.
  - Implement all 4 states (loading skeleton, empty, error with retry, populated) and both themes.
  - Comply with `app/tokens.ts`, zero raw colours.

### Task 3: Redesign InboxSurface (Keyboard Workstation, Media Fix & System Pulse)
- **Role:** `builder`
- **Tier:** `standard` (Opus)
- **Workstream:** `main`
- **Depends On:** `[Task 2]`
- **Write Set:**
  - `forge-control-web/app/desktop/InboxSurface.tsx`
- **Deliverables:**
  - Fix media URLs in HTML5 video player and scene thumbnails so `/api/proxy` rewrite succeeds without 404s.
  - Add 10s auto-refresh polling on inbox query.
  - Build Executive System Pulse dashboard for Inbox Zero state (fleet health, triage stats, upcoming reminders, quick actions).
  - Implement full keyboard navigation (`j`/`k`, `a`, `d`, `e`, `/`, `r`) and selection preservation on item resolution.
  - Add segmented priority filter tabs (`All`, `Urgent`, `QC`, `Reminders`, `History`) and instant search bar.
  - Render History / Resolved items view with decision audit trail.
  - Implement all 4 states (loading skeleton, empty, error with retry, populated) and both themes.
  - Comply with `app/tokens.ts`, zero raw colours.

### Task 4: Adversarial Review, Build & Visual Inspection
- **Role:** `reviewer`
- **Tier:** `standard` (Opus)
- **Workstream:** `main`
- **Depends On:** `[Task 3]`
- **Write Set:**
  - `WORKLOG.md`
  - `HANDOFF.md`
- **Deliverables:**
  - Review all diffs across `TodaySurface.tsx`, `InboxSurface.tsx`, `today.ts`, `inbox.ts`, `spend.ts`, `ai_os.ts`.
  - Verify `npx tsc --noEmit` and `npm run build` exit 0 cleanly.
  - Run `/opt/ai-os/workspace/shots-aios.mjs` to capture screenshots of `today` and `inbox` in dark and light themes, and across states.
  - Inspect screenshots visually and verify all layout, typography, token compliance, and interaction requirements.
  - Report findings honestly with real pasted outputs.
