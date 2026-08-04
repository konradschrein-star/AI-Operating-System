# PLAN — live-panel-manager-split

**Goal:** LEFT rail = what Konrad steers (conversations + one manager card per active project/goal).
RIGHT Live panel = only the selected manager's worker runs + their sub-agents. Kill the cross-project
mixing in the current global `/api/agents` flat list.

## Recommendation (what we build)

Two thin API additions in `forge-control`, then scope the web UI to a selected project group.
No schema migration — the `projects` table is already the authoritative source for a "manager"
(name, status, task counts); worker runs already carry `metadata.project_id`; sub-agents already
link via `parent_run_id`. The chat-rail exclusion in `runs.ts` stays untouched.

### Data facts (verified from code)
- **Worker run** of a project = `runs` row where `metadata ? 'project_id'` and `metadata->>'project_id' = <pid>`. Roles in `metadata.role` (architect|planner|scout|builder|reviewer).
- **Sub-agent** = `runs.parent_run_id` points at a worker run. Already nested by `/api/agents`.
- **Standalone chat** = `parent_run_id IS NULL AND NOT metadata ? 'project_id'` (never in Live feed once we filter by project).
- **Tokens** per run = `metadata->'usage_total_running'->>{input_tokens,output_tokens}` (bigint). **Cost** = `runs.spent_usd`.
- **Manager card** is derived from `projects` (status `active`/`blocked`) + aggregate over its worker runs. It is NOT a chat and never opens a thread.

### API changes (forge-control) — Round 1
1. **`GET /api/projects/managers`** — one row per active/blocked project, aggregated in a single SQL CTE (no N+1):
   ```
   { managers: [ {
       project_id, name, status, mode,          // mode = metadata->>'mode' ('goal' | null)
       tasks_done, tasks_total,                  // from project_tasks grouped by project_id
       tokens_in, tokens_out, spent_usd,         // SUM over worker runs (metadata.project_id = pid)
       last_activity_at                          // MAX(updated_at) over worker runs
   } ] }
   ```
   Ordered by `last_activity_at DESC NULLS LAST` so `managers[0]` is the most-recent group (the default selection).
   Rollup sums **worker runs only** (metadata.project_id = pid) — do NOT also add `parent_run_id` children unless psql confirms parent `spent_usd`/`usage_total_running` excludes them, to avoid double-counting. Coarse aggregate is acceptable per brief.
   **Route ordering:** register `/projects/managers` BEFORE any `/projects/:id` param route or Hono will match `managers` as an id.
2. **`GET /api/agents?project_id=<pid>`** — add an optional filter to the existing endpoint. When present,
   `fetchActiveRows` filters top-level runs to `metadata->>'project_id' = :pid` (keep the existing sub-agent nesting via `parent_run_id`; keep the 24h recency window & LIMIT). Scope the `summary` block to the filtered set. Response shape unchanged (`AgentsResponse`), so the web renderer barely changes.
   **Manager-run guard:** grep goal-mode seeding (recent `feat(goal-mode)` commit, `src/db/projects.ts` create path) to confirm whether a goal spawns a distinct orchestrator/"manager" run (e.g. `metadata.role = 'manager'`). If one exists, exclude it from this worker feed (`metadata->>'role' IS DISTINCT FROM 'manager'`). If none exists, skip — no-op.
   **Verify before finishing:** `psql -U postgres content_forge -c "select metadata->'usage_total_running', metadata->>'role', spent_usd from runs where metadata ? 'project_id' order by updated_at desc limit 8;"` to confirm the JSON path yields non-zero numbers.

### Web changes (forge-control-web) — Round 2
3. **`agentsApi.ts`**: `fetchAgents(projectId?: string)` appends `?project_id=`; add `fetchManagers()` → `/api/proxy/projects/managers` with a `Manager`/`ManagersResponse` type.
4. **Selection state**: lift `selectedManagerId: string | null` to `DesktopApp.tsx`; thread it into `ChatSurface` and down to `AgentActivity`. Default: when managers load and it's null, set to `managers[0].project_id`. This is a **separate selection from chat `selId`** — clicking a manager card scopes the Live panel only; it must NOT open a chat thread. If the selected id drops off the list (project went done/cancelled), fall back to `managers[0]` or empty.
5. **`ManagersSection`** (new component rendered inside the 300px left rail in `ChatSurface.tsx`, above the chat list): a labeled "Managers" section, one card per manager — name, status pill, `done/total` tasks, and tokens-or-EUR. Poll with React Query (~8s). Selected card highlighted via `--fg-selectedBg`. **Tokens only, both themes.** On fetch error show a visible error row (hard error, no silent fallback).
6. **`AgentActivity.tsx`**: accept `projectId` prop, pass to `fetchAgents`, render only that group's workers + nested sub-agents with per-worker token usage. Header shows the selected group's name; when no active project exists, an explicit empty state ("No active project group"). Do NOT touch the Files tab / SidePanel Files code.

### Failure & visibility
- Endpoint failures surface as visible error rows in the managers section and Live panel — never a silent empty list.
- No active projects → managers section empty + Live panel empty state, both explicit.
- Selected manager removed from list → deterministic fallback to most-recent.

## Rejected alternatives
- New `manager_runs` table / schema migration — rejected; `projects` already owns this state.
- Sum tokens in JS after fetching all runs — rejected; N+1 / heavy; one CTE aggregates in SQL.
- Separate `/api/projects/:id/agents` endpoint — rejected; `?project_id=` on `/api/agents` reuses the AgentRow + sub-agent rollup and keeps the response shape.
- Managers as their own top-level surface — rejected; Konrad's model puts them in the LEFT rail beside conversations.
- Splitting the web work across two concurrent builders — rejected; both touch `DesktopApp.tsx`/`ChatSurface.tsx`, so one web builder keeps the selection plumbing conflict-free.

## Hard constraints honored
- Do NOT touch `FileExplorerPanel*`, `forge-control/src/routes/files.ts`, or Files-specific code (parallel worktree).
- Chat-rail exclusion in `runs.ts` `listRuns`/`searchRuns` stays exactly as-is.
- Design tokens only; both themes must work. Never restart forge-executor.

## Rounds
- **R1 builder (API)** → **R2 builder (Web)** → **R3 reviewer** (tsc both repos, web build, curl endpoints with real non-zero JSON, grep for hex/rgb/hsl, verify both themes).
