# Round 601B — navStack in ChatSurface + drill-in shells

U20/U21, `13-ui-v3-architecture.md` §2. What this round did, what proves it,
and the one thing it found in the data that the plan did not predict.

---

## 1. The absorb (U21)

Four things were deleted from `ChatSurface.tsx` and replaced by one:

| Deleted (git `275b9d4`) | Replaced by |
|---|---|
| `agentViewFrom` state (`:265`) | `navStack` (`app/desktop/chat/nav-stack.ts`) |
| `isAgentView` derivation (`:301`) | `navStack.length > 0` |
| `SidePanel.onOpenRun` → `setSelId(runId)` (`:792`) | `openNode(node)` → `push(stack, frame)` |
| the floating "← agent view · back" button (`:660`) | `<BackButton>` inside each drilled view's header |

**`selId` no longer moves when you drill in.** That is the round's semantic
change. Before, clicking a worker pointed `selId` at the worker's run, which
re-scoped the right sidebar to that worker — the spec says the sidebar is
always a view of the currently open chat. `SidePanel` still gets
`chatId={selId}`; the team tree does not move while you read a worker.
Assertions **A2** and **B2** below check exactly this.

Switching chats resets the stack. The raw `useState` setter is private to
`openChat()` (`ChatSurface.tsx:298`), so there is no way to change chats that
skips the reset — asserted at **D2**.

## 2. Poll budget (NFU3)

While `navStack` is non-empty the manager `detailQ` is disabled
(`enabled: … && navStack.length === 0`) and `AgentChatView` runs exactly one
detail query at the same intervals (`live ? 20000 : 3000`). `useRunEvents`
stays on `selId`, untouched — one stream.

Measured over 30s at rest and 30s drilled, on chat `11dd264b` (20 team rows):

| | `/chat` | `/chat/:id` | `/chat/:id/team` | total |
|---|---|---|---|---|
| at rest (manager chat) | 4 | 9 | 6 | **19** |
| drilled into a worker | 3 | 10 | 5 | **18** |

Drilling in does not add a request. (Both columns are the same three
endpoints; the ±1 is poll-phase jitter across the 30s window.)

## 3. What the data actually contains — and the plan's gap

The brief said a sub-agent's entries are inline under
`meta.parent_tool_use_id` and its identity comes from
`metadata.subagents_v2[]`. Both are true **for runs the executor stamped**.
They are not true for most rows Konrad can click today. Curled against `:7798`
on 2026-08-06:

| run | team rows | `subagents_v2` | entries with `parent_tool_use_id` |
|---|---|---|---|
| `11dd264b` (operator chat) | 7 sub-agents | `[]` | 0 of 2477 |
| `ece63bdb` (operator chat) | 15 sub-agents | `[]` | 0 of 1911 |
| `58096061` (architect worker) | 1 sub-agent | present | 44 |

The team panel never depended on the rollup: `foldSubagents`
(`forge-control/src/routes/agents-shared.ts:222`) **seeds a row from every
Agent/Task `tool_call`** and enriches it from the rollup when one exists. A
drill-in that only understood the rollup answered *"no such sub-agent"* on
almost every row on screen — a failure dressed as honesty. So `AgentChatView`
reads the same two sources in the same order:

- **identity** — `subagents_v2` entry, else the spawn `tool_call`'s
  `input.subagent_type` / `input.description` / `meta.model`
- **transcript** — `subagentEntries()` (601A) for the inner steps, **plus the
  envelope**: the spawn `tool_call` (the brief it was given) and its
  `tool_result` (what it reported back), both carrying
  `meta.tool_use_id === id`

Every entry shown is one the executor wrote and tagged with that id — this is
derivation, not synthesis. A line above the transcript says which it is
("46 entries — 44 of this sub-agent's own, plus the spawn call and result that
framed it"), so a two-entry envelope is never mistaken for a two-entry
session. When neither source knows the id, nothing renders and the view says
both sources came up empty (NFU6).

## 4. Evidence in this directory

| File | Proves |
|---|---|
| `nav-stack-e2e.cjs` → `nav-stack-e2e.json` | **19/19 PASS** — drill-in leaves `selId` alone, two levels deep, back pops one level, chat switch resets, poll budget |
| `capture-nav.cjs` → `capture-nav.json` + 8 PNGs | `depth1`, `depth2`, `backhover`, `manager` × dark and light |
| `../../../scripts/checks/check-nav-stack.ts` | **47/47 PASS** — the reducer's invariants, including "pop at depth 1 yields the empty stack" and "a chat switch resets" |

### e2e assertions (all PASS)

```
A1  drilled view is the clicked worker; depth 1
A2  the TEAM PANEL still shows the same chat's tree (selId did not move)
A3  back button points at the manager chat
B1  sub-agent rows are clickable and descend to depth 2
B1b the frame FETCHES the parent worker, not the sub-agent id
B2  the team panel STILL shows the same chat's tree
B3  back now points one level down, not to the manager
C1  back from depth 2 lands at depth 1, on the frame below it
C2  back from depth 1 returns to the manager chat, team intact
D2  switching chats drops the drilled view (navStack reset)
E   drilled total does not exceed at-rest total
```

Header read off the live data at depth 1: `session · architect · sonnet-4-6 ·
canvas-ux · Plan: canvas-ux`, crumb `manager chat › session 58096061`. At
depth 2: `sub-agent · scout · sonnet-4-6 · Scout canvas-ux existing code`,
crumb `manager chat › session 58096061 › sub-agent toolu_01`.

## 5. Reproducing

Harness setup is `docs/plan/artifacts/phase500/README.md` §2 verbatim; this
round used port **7784** for the isolated web copy (7785–7789 were taken) and
the existing `:7798` API harness.

```bash
FORGE_SESSION_COOKIE="$(cat /tmp/session-cookie-phase601.txt)" \
NAV_BASE_URL=http://127.0.0.1:7784 \
  node docs/plan/artifacts/phase600/nav-stack-e2e.cjs
  node docs/plan/artifacts/phase600/capture-nav.cjs

(cd forge-control && npx tsc --noEmit)
(cd forge-control-web && npx tsc --noEmit && NODE_ENV=production pnpm build)
(cd forge-control-web && ../forge-control/node_modules/.bin/tsx ../scripts/checks/check-nav-stack.ts)
grep -rn "agentViewFrom" forge-control-web/app          # → 0
```

## 6. Deviations and known gaps

1. **`node.parent_id ?? node.id` was not used.** 13 §2's sketch is wrong for
   session rows: a worker's `parent_id` is its `parent_run_id`
   (`routes/chat.ts:495`) and is not always null, so a worker with a parent run
   would have drilled into its parent. `ChatSurface.openNode` discriminates on
   `kind` instead.
2. **`BackButton` lives in `AgentChatView.tsx`**, imported by `PlanDocView`.
   The round owns a fixed file list and a third component file is not on it.
3. **`PlanDocView` fetches nothing** and nothing pushes a `plandoc` frame. The
   U6 doc endpoint is phase 700's; the frame kind exists now so the stack's
   shape is settled before there are two callers to migrate.
4. **A refresh restores no frame at all — it lands on TODAY, not on the chat
   you were in.** `DesktopApp.tsx` holds `surface` in `useState<Surface>("today")`
   and persists it nowhere; clicking CHAT afterwards auto-opens the rail's most
   recent chat, which need not be the one you drilled from. Memory-only by
   design (13 §2) — a persisted frame would have to be validated against a tree
   that may have changed under it, and an invalid restored frame is a worse lie
   than a reset. *(Corrected in round 606. The original sentence read "A refresh
   lands on the manager chat"; round 604 measured the real behaviour and filed
   it as [README.md §6.2](README.md#62-round-601bs-readme-says-a-refresh-lands-on-the-manager-chat-it-lands-on-today),
   since an evidence round may not edit another round's document.)*
5. **`globals.css` lines 11–12** carry `#000` / `#ededee` in the `html, body`
   rule. Pre-existing, untouched: `git diff` on the file shows zero added
   colour literals.
6. **The `role` a sub-agent shows can differ between the panel and the drilled
   header** when neither the rollup nor the spawn input names one: the server
   defaults to `"agent"`, the client shows `—`. Cosmetic, and the honest
   direction; flagged for round 602 if it wants one vocabulary.
