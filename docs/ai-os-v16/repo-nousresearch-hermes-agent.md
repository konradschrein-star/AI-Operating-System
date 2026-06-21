# Nous Research `hermes-agent` — Evaluation for Personal AI OS

> NOT Konrad's Hermes. This is `github.com/NousResearch/hermes-agent` —
> "The agent that grows with you", 198k stars, MIT, primary lang Python
> (82%) with a TypeScript/React `web/` dashboard (13%). v0.17.0 (Jun 2026).

## TL;DR

A huge multi-channel agent CLI (Telegram/Discord/Slack/CLI) + Vite/React
operator dashboard. **Skip the Python core** — it's a 4.5k-line monolith
tightly coupled to their CLI/PTY model. **Cherry-pick the dashboard**:
the `SlashPopover` + `slashExec` contract + `fuzzyRank` ranker map 1:1
onto Konrad's chat-UX pain points, and the curator/skill-lifecycle
concept is worth stealing for the Skills/Memory surfaces.

## Repo overview

- **Type:** Full app (agent runtime + operator web UI + Ink TUI), not a library.
- **Top level:** `agent/` (Python loop, memory, providers), `apps/` (desktop+bootstrap),
  `web/` (React 19 + Vite + Tailwind 4 + xterm.js dashboard), `skills/` (markdown skill bank),
  `tools/`, `providers/`, `cli.py` (679KB!), `run_agent.py` (245KB).
- **Web UI surfaces (`web/src/pages/`):** Chat, Sessions, Cron, Skills, Models, Profiles,
  Plugins, MCP, Webhooks, Channels, Analytics, Logs, Files, Env, System, Pairing, Docs, Config.
  Konrad's AI OS has overlapping surfaces (Chat, Tasks, Skills, Memory, Pipeline, Control).
- **Chat reality check:** their `ChatPage.tsx` is a thin xterm.js viewport onto a remote
  PTY running an Ink TUI — it doesn't actually solve "Enter sends, slash commands,
  pretty scrolling" in React. The good React chat UX lives in the **TUI's contract**
  reimplemented as composable React pieces (`SlashPopover`, `slashExec`).

## License

**MIT.** Fully lift-compatible. Standard attribution boilerplate; no copyleft.
Keep their copyright header in any verbatim file copy.

## Where it overlaps with our AI OS surfaces

| Konrad surface              | Hermes equivalent                                     | Overlap                          |
| --------------------------- | ----------------------------------------------------- | -------------------------------- |
| Chat (Enter, slash, scroll) | `SlashPopover.tsx` + `slashExec.ts` + `fuzzy.ts`      | **High** — drop-in patterns      |
| Skills                      | `skills/*` markdown bank + `curator.py` lifecycle     | **Medium** — concept only        |
| Memory                      | `agent/memory_manager.py`, `curator.py` consolidation | **Medium** — design pattern      |
| Tasks/Pipeline              | `ScheduleBuilder.tsx`, `CronPage.tsx`                 | **Medium** — needs deps stripped |
| Autonomy (run loop)         | `conversation_loop.py` (4.5k lines, Python)           | **Low** — wrong language/stack   |
| Inbox                       | none                                                  | **None**                         |
| Control / Live              | xterm PTY embed                                       | **Low** — different model        |

## Top 3 reuse candidates → destinations

1. **`web/src/lib/slashExec.ts` (5KB) + `web/src/components/SlashPopover.tsx` (5KB)**
   → land in `apps/ai-os-console/src/components/chat/` of Konrad's OS.
   Self-contained except for one `lucide-react` icon and `@nous-research/ui`'s
   `ListItem` (swap for a V2 GlassCard row). Solves: slash autocomplete,
   keyboard handling via `ref.handleKey`, debounced completion fetch, Tab-to-apply,
   Esc-to-close. **Effort: 2-3 h** (port to inline-style V2, wire to local
   command registry instead of `gw.request("complete.slash")`).

2. **`web/src/lib/fuzzy.ts` (5KB) — `fuzzyScore` / `fuzzyRank`**
   → drop into `apps/ai-os-console/src/lib/` as-is. Zero deps, pure TS, MIT.
   Use for: slash command picker, model picker, skill picker, Library search,
   command palette. **Effort: 30 min** (copy + keep their attribution comment).

3. **Curator/skill-lifecycle pattern from `agent/curator.py`**
   → land as design doc for `apps/ai-os-console/server/skills-curator.ts`.
   Don't lift code (Python, 1.9k lines, tightly coupled to their FS layout).
   Lift the **ideas**: active → stale → archived transitions on inactivity timestamps,
   never-delete (archive only), pinned-bypass, periodic LLM-driven umbrella
   consolidation of overlapping skills. Maps onto AI OS Skills/Memory surfaces
   and the brain §20 "manager loop". **Effort: design only.**

## What to skip

- `cli.py` (679KB), `run_agent.py` (246KB), `hermes_state.py` (218KB), `agent/conversation_loop.py` (258KB) — monolithic Python, wrong stack.
- `ChatPage.tsx` — it's an xterm viewport, not a real React chat. Does not solve Konrad's chat pain.
- `@nous-research/ui` (their private UI kit) and `@xterm/*` — would fight V2 inline-style system.
- Multi-channel adapters (Telegram/Discord/Slack/WhatsApp) — out of scope.
- Their `trajectory_compressor.py` and `batch_runner.py` (training data gen).

## Risks

- **Tailwind v4 classes** in lifted components — strip and translate to V2 inline styles per `MEMORY.md`. Non-trivial but mechanical.
- **`@nous-research/ui` coupling** — `SlashPopover` imports `ListItem`; needs a 5-line replacement.
- **Gateway contract drift** — `slashExec` assumes their JSON-RPC `slash.exec` / `command.dispatch` endpoints. Konrad's Hono backend needs to implement (or stub) equivalent routes, or the executor needs to be rewired to a local command registry.
- **Naming collision** — keep "Nous Hermes" cleanly separated from Konrad's Hermes in code, docs, and commit messages.

## Verdict

**Cherry-pick.** Lift `slashExec.ts` + `SlashPopover.tsx` + `fuzzy.ts` (~15KB,
~3 h port), steal the curator lifecycle as a design pattern for Skills/Memory.
Ignore the Python agent core entirely.
