# aios-sidebar-live-sessions — plan

**Goal (Konrad's words):** the chat right-hand panel must answer, at a glance,
WHO is working, ON WHICH ENGINE, ON WHAT, and FOR HOW LONG.

**Shape:** one row per live session — engine badge · model · task title · what
it is doing right now · elapsed.

---

## Recommendation

**Widen the response the panel already polls; add one block above the tree that
already exists. No new endpoint, no new poll, no new stored state.**

1. **Server** — `GET /api/chat/:id/team` (`forge-control/src/routes/chat.ts:629`,
   node shaper `teamNodeFromRun` at `:511`) gains two fields per `TeamNode`:
   - `engine: string | null` — derived from the **model**, server-side, by
     importing `engineForModel` from `forge-control/src/lib/engine-session.ts`.
     Never `metadata.engine`.
   - `activity: { kind, tool, text, ts } | null` — for a run node from
     `run.current_activity` (already on the `AgentRun` that
     `teamNodeFromRun` receives — `agents-shared.ts:684` populates it via
     `pickCurrentActivity`); for a sub-agent from `sub.latest_activity`.
     **Shipped only on non-settled nodes**, and `text` truncated server-side,
     so the payload grows with the number of LIVE sessions (typically < 10),
     not with the size of the tree (measured trees reach 165 rows).

   Zero new SQL: both values are already selected and already parsed.
   `TEAM_RUN_COLUMNS` pulls `metadata`; nothing new is read, stored or written.

2. **Client** — a `LIVE SESSIONS` block pinned above the existing team tree
   inside `ChatTeamPanel`, rendering one row per non-settled node out of the
   **same `TeamResponse` already in the react-query cache**. Columns in
   Konrad's order: engine badge, model, task title, current activity, elapsed.
   The tree below it is unchanged; the PLAN split (`PLAN_FRACTION_KEY`) and its
   drag handle are untouched.

3. **The badge is data-driven, and ships two engines.** A `Record<string,
   BadgeStyle>` keyed by engine string, with an explicit fallback that renders
   an unknown engine's **raw string** in a neutral token. Adding a third engine
   later is one map entry. **There is no codex badge** — see Findings.

4. **`engine: null` when the model is unknown.** `engineForModel(null)` returns
   `"claude-code"` and is right to: for *dispatch*, an unknown model must never
   silently become Gemini. For a *badge* that same default asserts a fact
   nobody measured. So the server calls it only for a non-empty model and ships
   `null` otherwise; the row prints `—`.

## Why

- **The model is the only trustworthy engine key.** Over the last 7 days, 46
  rows carry `engine = claude-code` and a Gemini model — residue of the
  engine-key collision fixed 2026-08-25. A badge reading `metadata.engine`
  lies on those rows. `engineForModel` defers to `isGeminiModel`, the same
  predicate the real dispatcher uses, so the badge cannot drift from routing.
- **The data is already on the wire, one poll away.** `/chat/:id/team` polls at
  `TEAM_POLL_MS = 10_000` and *stops entirely* once `isTreeSettled` is true
  (`ChatTeamPanel.tsx:395`). It already carries `model`, `status`, `tokens`,
  `working_ms`, `started_at`, `description` and the joined `task {round, role,
  title, status}`. Only the engine and the activity are missing. The chat
  surface has a committed **40 req/min ceiling** (`pollBudget.ts`); this design
  spends zero additional requests.
- **The panel is not rebuilt, it is extended.** Dismissals, the ✕ cascade
  guard, stop/terminate, the peek group and the `memo` identity work that
  round 1302 measured all live in the tree. A live block *above* it adds the
  intel Konrad is missing without reopening any of that.

## Rejected alternatives

- **New `/api/live-sessions` poll** — buys nothing the widened response does not
  already carry, and every new poll on this surface must be paid for by slowing
  an existing one.
- **Render `metadata.engine`** — wrong on 46 measured rows; that is the trap.
- **Derive the engine client-side from the model string** — a second copy of
  `isGeminiModel` that will drift from the dispatcher within one model release.
- **Fleet-wide via `/api/agents` from the chat panel** — that endpoint carries a
  24h window including completed runs; a new poll plus a payload regression on
  the surface that was just cut from 2.5 MB to 1.7 KB.
- **Replace the tree with the live list** — throws away dismissals, the stop
  verbs, sub-agent lineage and the peek, all of which took several rounds.

## What owns what

| Question | Answer |
|---|---|
| What owns state | `runs.metadata` — `current_activity`, `model_resolved`, `subagents_v2[].latest_activity`, written by the executor rollup (`lib/run-rollup.ts`). This plan stores nothing new. |
| What dispatches work | Nothing. This is a read path only. |
| What happens on failure | `fetchChatTeam` throws on non-2xx and the panel renders `team unavailable — <server's own message>`; a partial enrichment already renders `partial data — <scope> failed`. New fields absent (older API) → `undefined` → the cell prints `—` / `n/a`, never `0` and never a guessed badge. |
| How Konrad sees it broke | Same two notes, plus: an unknown engine prints its raw string rather than a plausible badge, and every activity cell carries **its own age** so a frozen value can never read as fresh. |

**No silent fallbacks.** Three places are explicitly *not* allowed to swallow:
the engine badge (unknown → raw string, never "claude"), the activity cell
(unnamed → the kind plus its age, never blank-as-idle), and the elapsed cell
(`null` → `—`, never `0s`).

## The one measured hazard: the activity column can be blank

The sampled live run's `current_activity` was
`{kind: "tool_result", tool: null, text: null}`, and the /live surface's
`activityLabel` (`AgentActivity.tsx:165`) returns **`""`** for exactly that
shape. A "what is it doing right now" column that is empty half the time does
not answer Konrad's question. Round 1 measures the blank rate over real live
runs before anyone writes the cell; if it is high, the fix is to carry the
answering tool's name through `lib/run-rollup.ts` — **not** `executor.ts`.

## Also fixed

- `no project linked to this chat` renders **twice** — `ChatTeamPanel.tsx:1060`
  and `PlanKanban.tsx:693`. The panel-level note stays; the plan zone's goes.
- The PROJECT-picker overlap Konrad screenshotted is **unconfirmed**. Round 1
  reproduces the exact state (project-linked chat + picker expanded) and either
  fixes it or says plainly that it does not reproduce.

## Task graph

One workstream (`main`), one worktree, serialized — the tasks are small and the
file sets are disjoint; a second workstream would buy an integration task and a
merge risk for no wall-clock worth having.

```
T1 researcher  activity truth (blank-rate)        depends []
T2 researcher  before-evidence + overlap repro    depends []
T3 builder     server: engine + activity          depends [T1]
T4 builder     client: live strip + badge + notes depends [T2, T3]
T5 builder     after-evidence + bytes/min         depends [T4]
T6 reviewer    whole diff                         depends [T3, T4, T5]
```

## Definition of done

1. A screenshot of the real console showing one row per live session with all
   five facts, read back with the Read tool — **before merging**.
2. A Gemini-model row badged `agy` and a Claude row badged `claude-code`, in
   one shot, with the engine derived from the model.
3. `/chat/:id/team` bytes/min measured **in a real browser** before and after,
   with the after within a stated, argued margin.
4. The PLAN drag split still works, and the duplicate note is gone.
5. The PROJECT-picker overlap either fixed with evidence, or reported absent.

---

# Addendum — Konrad's scope toggle (his decision, 2026-08-25)

**The open question in this plan is already answered, and not by me.** The vault
spec `AI OS/Spec - Manager Chat UI v3.md` was edited today with an addendum
recording Konrad's own words:

> "Add a toggle at the top of the right sidebar: 'this chat' vs 'everything
> running', defaulting to this chat."

It further states that implementation "is folded into the in-flight project
`aios-sidebar-live-sessions`" — this one. So it is in scope, and the escalation
above is withdrawn: the scoped default I chose is right, and it gains an opt-in
switch.

**The v3 rejection still governs the default.** A chat opens scoped to itself,
selection still lives on the left, and the right side still gets no independent
selector for *which chat* it shows. What is permitted is one scope switch.

## How it is built

**Mount the component that already exists.** `LiveSurface.tsx:727` mounts
`<AgentActivity />` with no `projectId`, and `GET /api/agents` unfiltered
returns every run and sub-agent on the box. The addendum is explicit that the
"everything running" branch must mount *that same component* rather than grow a
second implementation of it. The toggle therefore lives in `ChatSurface.tsx`
(which mounts `<ChatTeamPanel>` at `:362`) and swaps between the two — not
inside `ChatTeamPanel`, which keeps its file owner unchanged.

## The constraint this creates, measured

`AgentActivity` polls `/api/agents` at a **hardcoded `refetchInterval: 4_000`**
(`AgentActivity.tsx:806`) — **15 req/min**. The chat surface has a committed
ceiling of **40 req/min** (`CHAT_SURFACE_REQ_PER_MIN_CEILING`) and
`scripts/checks/check-chat-delta.ts:449-465` asserts every interval against a
literal and sums them.

In "everything running" the team panel is unmounted, so its 6 req/min and
PlanKanban's 2 req/min stop: **net +7 req/min**. Against a documented worst case
of ~36, that lands at ~43 — **over the ceiling**. This must be resolved openly,
not discovered by the check going red:

- that `4_000` is a literal inside a component, so the budget's own instrument
  cannot see it. It moves into `pollBudget.ts` as a named constant, which is
  what that file exists for;
- and the sidebar mount takes a slower interval than the Live surface's, or the
  ceiling is re-argued in the open. Silently exceeding it is not an option.

Cost when the toggle is off — the default, and where Konrad will spend nearly
all his time — is **zero**.

## Added tasks

```
T7 builder   scope toggle + its own screenshot   depends [T4]
T8 reviewer  the toggle increment                depends [T7]
```

**Why a second reviewer rather than widening the first.** `POST
/projects/:id/tasks/:taskId/cancel` writes `status = 'cancelled'`, which
`project_tasks_status_check` does not permit — the endpoint cannot succeed on
this box, so the seeded graph is append-only and T6's dependency set is frozen.
Two reviewers over *disjoint* builder sets, each a genuine join of its own
increment, is the available shape; it is not two reviewers over one diff.
