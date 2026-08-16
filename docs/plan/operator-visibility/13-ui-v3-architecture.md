# 13 — UI v3 Architecture

Recommendation first: **keep the entire rework read-side and additive.** Four route-local additions to forge-control (linkage, team, plan, capabilities), one component subtree replacement in forge-control-web (the right panel), one navigation stack in ChatSurface, and a whole-app $-sweep. Nothing writes engine state; everything that WOULD (stop/terminate/message/resume) goes through the vault contract and feature-detection. State stays where it already lives (Postgres `runs`/`projects`/`tasks`, react-query caches); no new stores, no new daemons.

## 1. Component map (web)

```
DesktopApp
└─ ChatSurface                          (owns: selId, navigation stack, canvasOpen)
   ├─ ChatRail                          (was: chat list + ManagersSection; v3: list only, x/y badges)
   ├─ MiddleSurface                     (renders top of nav stack)
   │   ├─ ManagerChatView              (existing ChatThread: header slimmed, composer v3)
   │   ├─ AgentChatView                (worker/sub-agent transcript: OrientationStrip +
   │   │                                ReadableThread(ToolCallRow-summarized) + BackButton)
   │   └─ PlanDocView                  (MessageMarkdown over U6 doc endpoint + BackButton)
   └─ SidePanel
      ├─ Files tab                      (UNTOUCHED — foreign ownership)
      └─ Team tab → ChatTeamPanel      (NEW, replaces AgentActivity+LiveProjectsBody here)
          ├─ TeamTree                  (manager / workers / sub-agents rows, hover controls)
          └─ PlanKanban                (phases from the graph-ready store)
```

`/live` (standalone AgentActivity surface) survives unchanged except the $-sweep — it is the global fleet view; the chat panel is the scoped view. `AgentActivity.tsx` is NOT deleted; it loses its slot in the chat SidePanel only. `agentsApi.ts` remains the shared client data layer — TeamTree reuses its role/model/duration helpers.

## 2. What owns state

| State | Owner | Notes |
|---|---|---|
| Which chat is open | `ChatSurface.selId` (existing) | unchanged |
| Navigation stack (manager→worker→sub-agent→plan-doc) | NEW `navStack` state in ChatSurface: `Array<{kind:"agent",runId,subagentId?}\|{kind:"plandoc",name}>`; empty = manager chat | Generalizes the existing `agentViewFrom` backtrack (U21) — that mechanism is absorbed, not duplicated. Stack lives in memory only; a refresh lands you back on the manager chat (acceptable; boring). |
| Team + plan data | react-query caches keyed `["chat-team", chatId]`, `["chat-plan", chatId]` | 5–8s polls, `enabled` only while panel visible |
| Chat↔project link | Server-derived per request (U2) | never cached client-side beyond the query cache |
| Dismissals | existing dismissal-persistence mechanism (in-flight phase) | X button feeds it |
| Secret requests | react-query `["secrets","list"]` poll (existing cadence) | badge + auto-open derive from it |
| Capabilities | fetched once per session, `["capabilities"]`, staleTime Infinity | all-false today |

## 3. Read-side API design (forge-control)

All in route files (routes/chat.ts, routes/projects.ts, new routes/capabilities.ts); route-local SQL; **no changes to db/projects.ts, project-tick.ts, cc-runner.ts, executor.ts**. Shared run-shaping logic (frozen elapsed, agent_kind, subagent rollup) already lives in routes/agents.ts from phases 1–2 — export those helpers from agents.ts and import them in chat.ts. If that import direction gets ugly, extract `routes/agents-shared.ts` (a NEW file, allowed) and have both import it.

### GET /api/chat/:id/team
- Resolve chat→project (§5). No project → `{ manager, workers: [] }` (manager node still returned — a chat with no project still shows itself).
- Workers: `SELECT ... FROM runs WHERE metadata->>'project_id' = $1` ordered by created_at; each shaped with the phase-1/2 helpers; sub-agents from `metadata.subagents_v2` with thread fallback (existing logic).
- `working_ms` per §4, computed server-side so the client never re-derives truth.
- Failure mode: DB error → 500 with body; the web panel shows an inline error row (NFU6). Never a partial tree presented as complete.

### GET /api/chat/:id/plan (+ /plan/doc?name=)
- Tasks from route-local query over `tasks WHERE project_id = $1` grouped by `floor(round/100)*100`; `deps` = all task ids in lower rounds (the engine's real semantics made explicit — this IS the graph model's edge set, coarse today, refinable later without shape change).
- `doc_path` convention: a phase block maps to `docs/plan/*.md` files listed from `<workspace_dir>/docs/plan/` (fs readdir at request time, no index, no cache — plan dirs are small). Doc streaming: resolve, verify `realpath` stays under the plan dir, else 400. Rationale: routes/files.ts is off-limits and its roots don't cover per-project worktrees anyway.
- Failure: missing workspace_dir or unreadable dir → explicit `{docs: [], error: "..."}` field, panel renders the error text.

### GET /api/capabilities
- Static shape (U8), values read from a small server-side constant that engine-v2-research-lane flips per the vault contract (`Contract - Manager Control Plane API.md`). Boring by design: a hardcoded object, updated by the lane that ships each capability.

### GET /api/chat (list) additions
- One additional grouped query: `SELECT project_id, count(*) FILTER (WHERE status='done') AS done, count(*) AS total FROM tasks WHERE project_id = ANY($ids) GROUP BY project_id`, where `$ids` come from the page's resolved links. Linkage for the LIST uses metadata.origin_chat_id only (no thread_scan on the hot list path — scan is per-chat-detail only, it's O(thread) and the list is 30 wide). Consequence, stated plainly: old chats without `origin_chat_id` show no x/y in the rail until opened once (detail view resolves via scan and can backfill `origin_chat_id` into project.metadata via a route-local UPDATE — one-time, idempotent, logged).

## 4. Working-time model (U5)

`working_ms = Σ min(gap_i, CAP)` over consecutive thread-entry timestamps, where `CAP = 120_000ms`; gaps above CAP contribute 0 (idle: queue wait, stuck, awaiting input, human latency). Running nodes add `min(now − last_ts, CAP)`. Sub-agents: same formula over their attributed thread slice (parent_tool_use_id), falling back to `subagents_v2` started/updated stamps when slices are unavailable — fallback flagged with `working_ms_source: "rollup"` so imprecision is visible, per hard-error policy.

Why 120s: CC sessions emit tool events far more often than 2min while genuinely working; longer silences are overwhelmingly waits. It's a heuristic — it is DOCUMENTED and VISIBLE (`working_ms`, not "elapsed"), labeled "working" in the UI, and the constant lives in one place. Rejected: executor-instrumented true CPU time (engine file changes — forbidden this cycle); wall-clock (the exact lie Konrad complained about).

## 5. Chat↔project linkage (U1/U2)

- Write path: `POST /api/projects` body gains `origin_chat_id`; route merges into metadata. The operator should pass its own run id when creating projects — noted in the vault contract as an operator-prompt change (config, not engine code). 
- Read path fallback for pre-existing projects: scan the chat's thread `tool_result` entries for `"project"` payloads containing a uuid that exists in `projects` (bounded: first match wins, only entries whose `meta.tool` suggests an HTTP/Bash call that hit /api/projects). Marked `link_source: "thread_scan"` + rail marker (NFU6). Backfill on first resolution (§3) so the scan runs once per legacy chat, ever.
- Failure mode: ambiguous scan (two project uuids) → return the newest project AND `link_ambiguous: true`; UI shows both the link and a warning marker. Never guess silently.

## 6. Team tree rendering & hover (U15–U17, NFU2)

- One flat render pass over a memoized array (manager, then workers with their subagents inlined, depth field per row) — no recursive component nesting; depth → padding-left. Rows are `memo`ized; the ticking clock for running rows is a single `useSyncExternalStore`-style 1s tick consumed ONLY by a leaf `<WorkingTime>` component so a tick re-renders leaf spans, not rows.
- Hover controls: rendered always, revealed via CSS `:hover`/`:focus-within` opacity — zero React hover state (the proven phase-2 pattern: native `title` for lineage). Confirm step for X on running rows: two-click pattern (X → becomes "sure?" for 3s) rather than a modal — no mount cost, no focus trap.
- Control wiring: dismiss → existing dismissal persistence; stop/terminate/message → capability-gated buttons calling contract endpoints; all-false today → disabled + `title="engine support pending (control plane contract)"`.

## 7. Kanban / graph duality (U25–U27)

Client store type (from `16-ui-v3-graph-research.md`):
```ts
type PlanNode = { id: string; title: string; status: TaskStatus; round: number;
                  role: string; deps: string[]; meta: { tier?: string } }
```
Kanban = group `PlanNode[]` by phase block (round hundreds) with per-node status chips; a future graph toggle feeds the same array to React-Flow+ELK (nodes as-is, edges from deps). The toggle is OUT of scope; the store shape and a written mapping note are IN scope. Progress indicator = done/total over the same array — one source of truth for rail badge (server-computed) and panel bar (client-computed from the same tasks); reviewer checks they agree.

## 8. Worker-chat legibility (U22–U24)

- OrientationStrip: pure function of data already on the wire (`role`, `model`, task title/round from the plan query, `metadata.current_activity`). No new endpoint.
- ReadableThread: the existing AssistantThread mapping with a `summarize` render mode — ToolCallRow gains a `summary` line built by a pure per-tool formatter (Bash → first command token + exit hint; Read/Write/Edit → path; Task/Agent → description). Formatters are a table, not a chain of ifs, so adding tools is a row. Raw payload stays one expand away — same collapse/expand contract as today.
- Story-so-far: pure derivation (§ U24). Explicit anti-goal: no LLM call in the render path.

## 9. Failure modes, end to end

| Failure | Behavior | Visible how |
|---|---|---|
| team/plan fetch fails | inline error row in the zone, stale data cleared | red-tinted (token: bleed) text with the HTTP status |
| chat unlinked | empty zones + one muted line | intentional empty state (U19) |
| thread_scan linkage | works, marked | "linked heuristically" marker (NFU6) |
| capability absent | control disabled | tooltip names the contract |
| plan doc missing/unreadable | error text in middle surface | explicit message, back button still works |
| working_ms from rollup fallback | value shown, source flagged | subtle `~` prefix + title text |
| SSE drops | existing polling fallback indicator, now docked at the status dot | "polling" label (U12) |

## 10. How Konrad sees progress (observability of the project itself)

Each phase commits artifacts under `docs/plan/artifacts/phase<NNN>/` (screenshots dark+light, check scripts, curl transcripts, profiler traces where required). The Kanban this project builds will, once phase 700 lands, display this very project's plan — the system becomes its own progress display. Until then: `GET /api/projects/8ea0cc08.../` task list + git log.

## 11. Technology choices (one-line rationale each)

- Plain react-query polls over new SSE channels — the data is small, cadence-tolerant, and SSE already exists only for chat detail; adding channels is engine-adjacent risk for no felt gain.
- CSS transitions for back-button/drill animation — no animation dep exists (NFU8); 200ms transform/opacity is enough to "feel the context switch".
- Native `title` + CSS reveals for hover — proven in phase 2 to be the zero-cost path (NFU2).
- Route-local SQL over db/ helpers — honors the engine-files freeze; mirrors the constraint already given for agents.ts.
- fs-readdir plan-doc listing over an index/registry — plan dirs are ~20 files; boring wins.
- Hardcoded capabilities constant over dynamic probing — the contract lane flips booleans in one place; probing invents failure modes.

## 12. Rejected alternatives (one line each)

- New `chats↔projects` join table: migration + engine coupling for what metadata + one backfill covers.
- Client-side working-time derivation: duplicates truth per consumer; server computes once (phase-1 lesson).
- Replacing SidePanel wholesale including Files: Files is foreign-owned and frozen.
- WebSocket live team feed: over-engineering at 1 operator; polls are within budget (NFU3).
- Modal confirms for destructive hover actions: mount cost + focus management for a two-click pattern's job.
- LLM-generated story-so-far: new pipeline, new spend, new latency — derivation first, gap documented if insufficient.
- `@xyflow/react` now: dead weight until the graph toggle phase; the store shape is the actual investment.
