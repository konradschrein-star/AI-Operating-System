# 02 — Architecture

## 1. Recommendation (first)

**Fix truth at the API boundary, legibility at the classification layer, speed at the component layer, and transparency at the renderer layer — all as additive changes over data that already exists.** Concretely: (a) `routes/agents.ts` starts selecting `completed_at` and projecting `settled_at`, `agent_kind`, `role`, `project_id`, `cron_name`, and per-sub-agent `ended_at`/`description`; (b) `AgentActivity.tsx` funnels all duration math through one settled-aware helper; (c) the hover fix is whatever the trace proves, with React.memo + CSS-`:hover` as the expected shape; (d) chat gains `tools.by_name` renderers for `Agent`/`SendMessage` over the existing thread pipeline, plus `parent_tool_use_id` threading in `thread-mapping.ts`. No migrations, no new dependencies, no engine files, no new state owners.

Rejected alternatives, one line each:

- *Compute settled durations client-side from `completed_at`* — pushes the truth rule into every consumer (web + mobile PWA); the API is the single choke point, fix it there.
- *Add a `settled_at` column or backfill cancelled rows* — a migration for data that `COALESCE` already answers; engine's cancel path is not ours to fix this cycle.
- *New `/api/agents/v2`* — versioning for an additive change; strictly-additive fields on v1 keep both consumers working.
- *WebSocket/SSE for the Live panel* — polling isn't the proven problem; don't rebuild transport to fix a hover.
- *Tooltip library (floating-ui etc.) for lineage* — a dependency and a mount cost to solve what CSS visibility solves; NF4 forbids it anyway.
- *Nesting sub-agent transcript entries inside their Agent block* — requires restructuring the assistant-message grouping algorithm mid-cycle; marking attribution gets the legibility at a fraction of the risk (revisit later if Konrad wants full nesting).
- *New notification plumbing so agent completions appear in chat* — dies inside `cc-runner.ts`, an engine file owned by engine-v2-research-lane; the brief's escape hatch says document, so we document (R19).

## 2. System as it exists (recon summary, verified 2026-08-05)

### 2.1 Data flow, Live panel

```
Postgres runs (content_forge)                    forge-control :7700               forge-control-web :7701
┌─────────────────────────────┐   4s poll   ┌──────────────────────────┐      ┌────────────────────────────┐
│ columns: status, started_at,│◄────────────│ routes/agents.ts         │◄─────│ react-query                │
│ completed_at, updated_at,   │             │  fetchActiveRows (≤60,   │      │  AgentActivity 4s          │
│ parent_run_id, worker,      │             │   24h window)            │      │  ManagersSection 8s        │
│ metadata jsonb:             │             │  agentFromRow            │      │ AgentActivity.tsx rows     │
│  role, project_id, model,   │             │  subagentsFromRollup     │      │  AgentRunLine / SubagentLine│
│  model_resolved, cron_id,   │             │  ← DROPS completed_at,   │      │  useSharedClock (1s, gated)│
│  subagents_v2[] (ended_at!, │             │    role, project_id,     │      └────────────────────────────┘
│  description!), rollup_v1   │             │    ended_at, description │
└─────────────────────────────┘             └──────────────────────────┘
```

Executor (off-limits) writes `runs` + rollup every 2s. `elapsed_ms` is computed at agents.ts:537–538 as `now − started_at` unconditionally — the time-truth bug. `completed_at` is populated on all completed/failed rows; only cancelled rows (4 legacy) lack it and carry the settle time in `updated_at`.

### 2.2 Data flow, chat transcript

```
runs.thread jsonb ──GET /api/chat/:id──► ChatSurface(detailQ) ──► AssistantThread.mapThreadToMessages
  {role, content, ts, kind?, meta?}         + SSE snapshots           (thread-mapping.ts: dispatch on role/kind ONLY)
  meta for tool_call: tool_use_id, tool,                                 │
        input (≤1500 chars), parent_tool_use_id?                         ▼
  meta for tool_result: tool_use_id, is_error,          MessagePrimitive.Parts { tools: { Fallback: ToolCallRow } }
        parent_tool_use_id?                             ToolCallRow = the "Bash block": collapsible, tokens.toolBg,
                                                        dot(color), preview 110 chars, ARGS/RESULT <pre> sections
```

Facts that gate design: there is no per-tool dispatch anywhere today (`tools.by_name` unused; verified supported by installed assistant-ui 0.14.24); `thread-mapping.ts` drops `parent_tool_use_id` and the call-side `is_error`; `Agent` (not `Task`) is the CLI's spawn tool name (63 occurrences vs 0); the harness's **async task-completion notification** never reaches the thread (the `evt.type === "user"` branch of `cc-runner.ts`, `:502–514` @ `b02aa62`, forwards only `tool_result` blocks; closed `CcEvent` union at `:234–235`) — *pins corrected round 1350, old `:417–429` drifted; see `docs/plan/notification-gap.md` §2b, and note this is narrower than "completion payloads never reach the thread", which is false*.

### 2.3 Kind signals in `runs` (verified against live data, 245 rows)

| kind | signature |
|---|---|
| operator chat | `worker='forge-executor'`, no `project_id`/`role`/`cron_id`, `parent_run_id` NULL |
| project worker | `worker='project:<role>'`, `metadata.role`+`project_id`+`task_id` |
| child run | `parent_run_id` NOT NULL (30 rows), same project metadata shape |
| cron/watchdog | `metadata.cron_id`/`cron_name`, `source='cron'` (143 rows) |
| in-process sub-agent | not a row — element of parent's `metadata.subagents_v2[]` with `role`, `model`, `description`, `started_at`, `ended_at`, `status` |

## 3. Component design — Phase 1, time truth

### 3.1 Server (`routes/agents.ts` only)

- Add `completed_at::text` to both SELECTs (`fetchActiveRows`, `/:id`).
- `agentFromRow`:
  ```ts
  const settled = ["completed", "failed", "cancelled"].includes(row.status);
  const settledAtMs = settled ? Date.parse(row.completed_at ?? row.updated_at) : NaN;
  const elapsed_ms = !Number.isFinite(startedMs) ? null
    : settled && Number.isFinite(settledAtMs) ? Math.max(0, settledAtMs - startedMs)
    : Math.max(0, nowMs - startedMs);
  ```
  plus `settled` and `settled_at` on the wire (R2). Hard rule: if `settled` but both timestamps unparsable → `elapsed_ms: null` (renders `—`), never a now-derived number.
- `subagentsFromRollup`: pass through `ended_at ?? null`, `description ?? null` (R3). Types updated in the local interfaces (agents.ts owns its own response types — no shared engine types touched).

Failure modes: NULL `started_at` (queued rows) → null elapsed, client renders `—`. Stuck→settled later: `completeRun` stamps `completed_at` whenever it settles, covered. Rollup lost on executor restart (rollup is in-process): sub-agents of runs spanning a restart may lack `ended_at` → client fallback chain (R5) ends in `—`, visibly.

### 3.2 Client (`agentsApi.ts`, `AgentActivity.tsx`)

One module-level helper pair (R6):

```ts
export function runElapsedMs(a: AgentRow, now: number): number | null   // settled → a.elapsed_ms verbatim; live → now − started_at; queued/unparsable → null
export function subagentElapsedMs(s: SubagentRow, now: number): number | null  // running → now − started; done → ended_at − started; fallback updated_at − started; else null
```

`AgentRunLine`/`SubagentLine` call these and nothing else. `humanDuration(null)` already renders `—`. The `useSharedClock` gating stays; with settled rows frozen, the clock also stops sooner (side benefit: fewer 1s re-renders — note for phase 3's baseline interpretation).

## 4. Component design — Phase 2, kind truth

### 4.1 Server classification (in `agentFromRow`)

Ordered precedence, first match wins, `unknown` is a real value (§operability — never guess):

```ts
const agent_kind =
  meta.cron_id ? "cron"
  : meta.project_id && meta.role ? "worker"
  : row.worker === "forge-executor" ? "operator"
  : "unknown";
```

Projected additively: `agent_kind`, `role`, `project_id`, `cron_name`. The `unknown` bucket is expected to be near-empty in practice (7 engine-less legacy rows); if it shows up in the panel, that is signal, which is the point.

### 4.2 Panel rendering

Row grammar extends the existing idiom (no redesign):

```
● fable-5  operator   Chat: rework live panel            36m 52s · ↓ 204.7k     ← operator chat
● opus-5   builder    Phase 1: time truth                 4m 12s · ↓ 88.1k     ← project worker (role from R7)
  ○ Explore opus-5    Recon chat Bash block rendering     1m 47s · ↓ 132.1k    ← sub-agent: description as title (R3)
● haiku    cron       watchdog: heartbeat check              12s · ↓ 3.2k      ← cron
```

- Kind badge: small mono label colored by token (`operator` → `tokens.accent`, worker roles → per-role color already used in ChatSurface's `ROLE_COLOR` — reuse/centralize that map, `cron` → `tokens.textMuted`, `unknown` → `tokens.warn`). Both themes come free via tokens.
- Model display mapping (R8): pure function, unit-tested, unknown ids verbatim.
- Sub-agent title becomes `description || role` (today it shows latest-activity text; keep activity on the second line slot that already exists for parents, or as `title` attr — planner decides, spec: description must be visible without hover).

### 4.3 Lineage on hover (R10) — decision

**Recommendation: enriched native `title` attributes** composed at render time from data already on the row (`parent run title` for sub-agents needs nothing new — the sub-agent renders under its parent; the title spells it out: `sub-agent of "<parent.title>" · <model> · started <t>`). Native titles cost zero JS, zero layout, zero state — they cannot regress phase 3.
Rejected: CSS pseudo-tooltip (`::after`) — richer visuals but adds absolutely-positioned layout work inside an `overflowY: auto` scroller and risks clipping; not worth it for v1. If Konrad wants pretty tooltips later, that's a follow-up with the perf harness already in place to police it.
Child runs (`parent_run_id` set, top-level rows): title includes `child of <parent_run_id ····8>`; full org-chart linking across top-level rows is out of scope (panel is flat + one nesting level today; a stranger still reads the org chart because workers carry role + project and sub-agents nest under parents).

## 5. Component design — Phase 3, hover performance

### 5.1 Protocol-first stance

No fix lands without a baseline trace (R12) and a named mechanism found in that trace (R13). Protocol and numeric gates live in `03-quality.md` §4 so builder and reviewer run literally the same script.

### 5.2 Candidate mechanisms (starting hypotheses for the trace, not conclusions)

1. **Per-row `useState` hover in `ChatListItem`** (ChatSurface.tsx:961–966): each enter/leave commits a state update; if rows are unmemoized children of a large tree, one mouse move across N rows = N commits of nontrivial subtrees.
2. **Poll-driven commit storms coinciding with hover**: three queries (agents 4s, managers 8s, chat 3s — plus 1s SSE snapshots when a run is live) re-render `ChatSurface` wholesale; `agents` responses are large (≤60 runs × full usage/rollup JSON) and `useMemo` keyed on `q.data` invalidates every poll because the object identity changes each fetch even when payload is equal.
3. **Style-recalc churn from inline style objects**: every commit re-creates hundreds of style objects; cheap individually, measurable in aggregate on a re-render storm.
4. **The side-panel task list's direct DOM style mutation** (ChatSurface.tsx:186–191) — cheap by itself; suspect only if the trace says so.

### 5.3 Expected fix shapes (choose by evidence)

- `React.memo` on `ChatListItem` (and rail siblings) with primitive props; move hover visual to a CSS class (`.chat-row:hover .close-x { … }`) killing the `useState` entirely — the ✕ affordance is pure presentation.
- If polls are the storm: `structuralSharing` is on by default in react-query — verify it's not defeated (fresh object identities from `fetchAgents` mapping); memo row props to primitives so identical data → zero row re-renders.
- Rate matters less than fan-out: do **not** slow the polls to pass the gate (that trades truthfulness for a benchmark); NF: cadence changes only if the trace proves cadence itself is the cause, and then with Konrad-visible justification in findings.md.

### 5.4 Failure modes

Fix regresses behavior (R15 click-through covers); memo hides a legit update (structural sharing + primitive props make staleness impossible by construction — reviewer checks status dot updates live); measurement flakes on a busy VPS (protocol pins CPU-noise handling: 3 runs, median, recorded machine load).

## 6. Component design — Phase 4, agent comms in chat

### 6.1 Mapping layer (`thread-mapping.ts`)

- `ToolCallPart` gains `parentToolUseId?: string`; populate from `meta.parent_tool_use_id` (R16).
- Build `spawnIndex: Map<tool_use_id, {description, subagentType}>` in the same single pass, from `Agent` tool_calls (parse `meta.input` JSON; on parse failure, store nothing — attribution then falls back to short id). Attach `agentLabel` to parts whose `parentToolUseId` hits the map (R18). Pure, fixture-tested.
- No change to grouping/back-search logic.

### 6.2 Renderers (`AssistantThread.tsx`)

```tsx
tools: {
  by_name: { Agent: AgentSpawnRow, SendMessage: SendMessageRow },
  Fallback: ToolCallRow,          // Bash & everything else — unchanged
}
```

`AgentSpawnRow` / `SendMessageRow` are structural siblings of `ToolCallRow` (same collapse state, same tokens, same 110-char preview discipline):

```
┌ → agent · Explore  "Recon chat Bash block rendering"          running ▸ ┐   ← spawn, collapsed
┌ → agent · Explore  "Recon chat Bash block rendering"             done ▾ ┐
│ PROMPT                                                                   │
│ <full prompt payload, pre-wrap mono, maxHeight 260 scroll>               │
│ LAUNCH                                                                   │
│ Async agent launched successfully…                                       │
└──────────────────────────────────────────────────────────────────────────┘
┌ → send · a28e674…  "Resume RAG recovery — verify partial work first" ▸ ┐  ← SendMessage
│ MESSAGE  <full message>                                                 │
│ ← reply  <tool_result content>                                          │
```

Direction grammar: `→` = operator sends (spawn prompt, SendMessage), `←` = operator receives (SendMessage reply/result). Colors: reuse `ToolCallRow`'s state coding (pending `tokens.warn`, done `tokens.info`, error `tokens.bleed`); the direction marker + "agent"/"send" label use `tokens.accent` to lift them above plain tools. All payload parsing is defensive: `JSON.parse` failure → raw `argsText` in the expanded body under an explicit `UNPARSED PAYLOAD` label (R20). SendMessage inputs contain CLI-duplicated fields (`to`/`recipient`, `message`/`content`) — prefer `to`/`message`, tolerate either.
Sub-agent attribution (R18): parts with `parentToolUseId` get a left-rail marker + `agentLabel` chip; visual weight low (they are context, not headline).

### 6.3 What is knowingly absent (R19)

The harness's **async task-completion notification** — the banner announcing a background agent finished — is not in the thread; it dies in `cc-runner.ts:502–514`, whose `user`-event loop forwards `tool_result` blocks and nothing else. `docs/plan/notification-gap.md` records: exact code path, the closed `CcEvent` union (`:234–235`), the minimal future fix (new event type → `appendThreadEntry` with a new `kind: "task_notification"` → one mapping branch → these same renderers pick it up), and ownership (engine-v2-research-lane). The renderers are built so that if that `kind` ever appears, the fallback path shows it rather than dropping it. *Old pins `:417–429` / `:170–188` drifted and were corrected round 1350 against `b02aa62`.*

Scope correction (round 1350): this section previously read "agent completion payloads … are not in the thread", which was too broad. A **synchronous** sub-agent's final text *is* in the thread as a `tool_result` entry, an **async** sub-agent's own entries are inline under `meta.parent_tool_use_id`, and peer-run traffic arrives via `POST /api/runs/:id/message` as `kind: "comms"`. Only the notification itself is absent.

## 7. Interfaces changed (complete list)

| Interface | Where | Change |
|---|---|---|
| `AgentRun` (wire) | routes/agents.ts + agentsApi.ts mirror | + `settled`, `settled_at`, `agent_kind`, `role`, `project_id`, `cron_name` |
| `Subagent` (wire) | same | + `ended_at`, `description` |
| `ToolCallPart` | thread-mapping.ts | + `parentToolUseId?`, `agentLabel?` |
| assistant-ui tool registry | AssistantThread.tsx:127 | + `by_name: { Agent, SendMessage }` |

Everything additive; no consumer breaks; mobile PWA unaffected.

## 8. Observability of this project itself

Progress is observable in the standard places: task board (`/api/projects/<id>`), per-phase commits on `project/8ea0cc08` (pushed to origin), phase artifacts under `docs/plan/perf/` and `docs/plan/notification-gap.md`, reviewer logs with pasted command output. Failure surfaces: a failed task blocks the round and notifies (engine behavior); merge conflicts at deploy stop the phase with a file list per the brief.
