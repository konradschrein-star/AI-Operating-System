# 11 — UI v3 Vision (Chat-Manager rework)

Status: authoritative for rounds 300–999. Derives from `10-ui-v3-spec.md` (Konrad's dictated spec, 2026-08-05 — THE LAW; where anything below or anything already built conflicts with it, the spec wins). Supersedes the manager-cards rail shipped by `live-panel-manager-split` and the two-zone SidePanel split.

## The goal, restated precisely

Rebuild the chat surface around one mental model: **every chat IS a manager**. The person Konrad talks to in a chat is his right-hand man running a team. Consequences, each load-bearing:

1. There is no separate managers section anywhere. The left rail lists chats; a chat that owns a project shows `x/y tasks` progress and its status dot inline. `ManagersSection.tsx` dies.
2. The right sidebar is ONE panel with two zones — team (top) and plan/Kanban (bottom) — and it is always a view of **the currently open chat**. It never has its own selector. No chat open or chat owns nothing → zones are simply empty.
3. The team zone is an org chart: manager at top (model shown), its full Claude-Code-session workers indented once (role, model, tokens, actual working time), their in-process sub-agents indented twice. Running rows tick; finished rows keep tokens/model but show no time. Hover exposes a red X (terminate/dismiss) and a stop button (stop ≠ dismiss). Click opens that agent's transcript in the middle surface. Finished sub-agents never vanish.
4. The plan zone is a Kanban of this chat's project phases; clicking a phase renders its plan markdown in the middle surface with back-navigation. The underlying task model is a graph (nodes = tasks, edges = dependencies) so a graph-view toggle is a later render swap, not a rewrite.
5. **No dollar figures anywhere in the UI.** Konrad runs on the Claude Code subscription; $ numbers are noise. Tokens/context are the currency shown. This is a whole-app sweep, not just the chat surface.
6. The chat header slims down (dot + model + canvas button; Live indicator docks to the dot). The composer autogrows, keeps the manager-only model selector, gains color-ramped effort buttons, and the secret sharer becomes two-way (agent-requested secrets open the panel with the request text; secrets never transit the chat log in either direction).
7. Worker chats become legible (spec addendum): orientation strip pinned at top, tool calls collapsed to one-line human summaries with the agent's prose as the primary reading layer, and a story-so-far digest for long sessions. Same for sub-agent chats.

## Definition of done

- The spec's "Explicitly rejected" list stays rejected: no managers section, no right-panel independent selection, no $ anywhere.
- A stranger opening a chat can read: who the manager is, who works for it, on what model, how far the plan is, and can descend into any worker/sub-agent transcript and walk back out.
- `npx tsc --noEmit` clean in forge-control and forge-control-web; `pnpm build` passes in forge-control-web; both themes verified by screenshot for every UI phase.
- Deployed to /opt/forge-ai-os per the merge-main-first runbook, pm2 online, `/api/health` ok.

## Measurable success criteria

- `grep -rn` for spend/USD/$ render paths in `forge-control-web/app` returns zero UI-visible hits (allowlist: code comments, API types kept for compat).
- `GET /api/chat` returns `tasks_done`/`tasks_total`/`project_id` per chat that owns a project; the rail renders them.
- `GET /api/chat/:id/team` returns the manager→workers→sub-agents tree with tokens and working-time per node; settled nodes' times are frozen (two curls 10s apart, identical values).
- Row hover in the team tree triggers zero React re-renders (verified with React DevTools profiler / why-did-you-render sampling) — hover affordances are CSS-only reveals.
- Composer grows with content (min 2 rows → max ~10, then scrolls); verified by Playwright.
- A pending agent secret request (secrets store `for_konrad` flag + request note) opens the secret panel with the request text visible; the stored value never appears in `runs.thread` (DB-level assert in review).
- Kanban phase click renders the phase's `docs/plan/*.md` in the middle surface; back button returns to the manager chat.

## Explicit non-goals (this project)

- **Anything that makes the executor act**: send-message-into-running-session, resume/chat-with-finished session, hard terminate, stop-current-work. Those are engine-v2-research-lane's, defined by `Contract - Manager Control Plane API.md` (vault). We build the UI against that contract with feature-detection and disabled-with-reason states — never silent fallbacks.
- The graph-view toggle itself. We ship Kanban with a graph-ready data model (see `16-ui-v3-graph-research.md`); the toggle is a reserved later phase (rounds 1200+).
- The deep hover-perf instrumentation phase and the operator-comms chat blocks — those live at rounds 1300/1400 (original phases 3–4, deferred) and will run AFTER v3 against the new layout. v3 must not regress hover performance (non-regression budget in `14-ui-v3-quality.md`) and must keep the thread-mapping layer intact so the comms renderers slot in.
- LLM-generated summaries requiring new model calls in the hot path. "Story so far" digests derive from data already in the thread; if derivation proves insufficient, the phase documents exactly what's missing rather than building new plumbing.
- Redesigning `/live` (the standalone global AgentActivity surface). It keeps phases 1–2 goods and loses only its $ displays in the global sweep.
- Touching Files components (FileExplorerPanel*, VaultFileList*, routes/files.ts) or engine files (project-tick.ts, cc-runner.ts, executor.ts, db/projects.ts).

## What we keep and integrate (already built / in flight)

- Frozen durations for settled runs and sub-agents (phase 1, R1–R6) — reuse `agents.ts` elapsed logic and the client duration helpers verbatim.
- `agent_kind` classification + role/model on the wire (phase 2, R7–R11) — the team tree consumes this, it does not reinvent it.
- Secret store one-way flow (`SecretField.tsx` → POST /api/secrets) — extended to two-way, not replaced.
- Dismissal persistence and browser-screenshot rendering from parallel in-flight work — preserve their mount points; do not regress them.
- The SSE chat stream, slash-command system, assistant-ui thread, and `MessageMarkdown` renderer.
