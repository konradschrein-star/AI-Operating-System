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

---

## Maximalist evaluation (2026-06-21)

Re-audit triggered by Konrad: personal side project, no commercial/distribution
constraint, so license + ops surface are no longer veto factors. Re-walked the
repo with the "buffet" lens.

**Deeper findings vs. first pass:**

- `agent/conversation_loop.py` (4561 LOC) is the real engine: streaming + tool
  dispatch + retry/failover + image-error backoff + compression + post-turn
  memory/skill review. Cleanly extracted from `run_agent.py` via
  `build_turn_context(agent, ...)`. **Could replace `forge-executor` if we run
  a Python sidecar; but adapter surface to our Hono `runs` table is non-trivial.**
- `agent/curator.py` (1916 LOC) + `memory_manager.py` (949 LOC) +
  `conversation_compression.py` (958 LOC) + `context_compressor.py` (2475 LOC)
  are a complete memory subsystem with provider plug-in slots. Maps onto our
  Postgres+halfvec layer as a richer brain, not a replacement.
- Multi-channel adapters are **massive**: telegram/discord adapters are ~7100
  LOC each, slack ~4100. They speak a `BasePlatformAdapter` contract
  (`gateway/platforms/base.py`) — too coupled to lift wholesale, but the
  contract + Telegram adapter alone is enough for "DM your AI OS from your phone".
- Dashboard pages all import `@nous-research/ui` (private kit) + `lucide-react`
  + Tailwind utilities — every page lift needs V2 inline-style port. Their
  `WebhooksPage`, `CronPage`, `ModelsPage`, `PluginsPage`, `ScheduleBuilder`
  are the most reusable.
- `trajectory_compressor.py` (1579 LOC) targets training data, but the
  middle-turn compression algorithm is exactly what `runs.thread` needs at
  long lengths. Port the algorithm, not the CLI.

**VPS ground truth (just measured):** 62 GB RAM, 41 GB available, 372 GB free
on `/opt`, 16 cores, load 1.34. Hermes-agent's Python stack (uv venv ~3 GB,
runtime ~500 MB-1 GB) fits comfortably. Plenty of headroom.

### Tier 1 — Minimal (~3 h, status quo)
What we had: lift `web/src/lib/slashExec.ts` + `web/src/components/SlashPopover.tsx` + `web/src/lib/fuzzy.ts` (~15KB) → `apps/hermes-workspace/src/screens/chat/`. V2 inline-style port, swap `@nous-research/ui` `ListItem` for `GlassCard` row, wire to local command registry. **Gain:** slash autocomplete, fuzzy ranking, keyboard contract. **VPS impact:** zero. **Risk:** none.

### Tier 2 — Mid (~25-35 h, recommended)
Tier 1 plus:
1. **Port `trajectory_compressor.py` middle-turn algorithm** → `apps/hermes-control-plane/src/lib/thread-compressor.ts` (TS rewrite, ~400 LOC). Compresses `runs.thread` when token budget exceeded. **6 h.**
2. **Lift `WebhooksPage.tsx` + `CronPage.tsx` + `ScheduleBuilder.tsx`** → `apps/hermes-workspace/src/screens/{webhooks,cron}/`. Strip lucide-react + `@nous-research/ui`, port to V2 inline + Material Symbols. New Webhooks surface = inbound triggers from external services. CronPage replaces our `tasks` cron UI with their richer `ScheduleBuilder` (NL→cron). **12 h.**
3. **Port `curator.py` lifecycle** to `apps/hermes-control-plane/src/services/skills-curator.ts` (~500 LOC TS). Drives `skills.last_used_at` → stale/archived transitions, LLM consolidation via claude-pool. **8 h.**
4. **`agent/memory_manager.py` design** → augment our `memory/` tables with pre-turn prefetch + post-turn sync hooks called from `forge-executor`. Pattern-only lift. **4 h.**

**Gain:** thread compression unblocks 1M-context Opus 4.7 runs; new webhooks surface (Stripe/GitHub/Telegram callbacks → AI OS task); richer cron UI; self-maintaining skills bank. **VPS impact:** zero new processes. **Risk:** V2 port mechanical but slow; curator LLM calls add claude-pool load (negligible at personal scale).

### Tier 3 — Maximalist (~80-120 h)
Tier 2 plus:
1. **Run hermes-agent Python as `forge-executor-py` PM2 process** on VPS (~1 GB RAM, ~3 GB venv on disk). Adapter shim: Hono backend POSTs runs to FastAPI sidecar, sidecar streams turn events back over SSE → writes `runs.events`. Replace `forge-executor` TS loop with `conversation_loop.run_conversation()`. Gets us: streaming tool dispatch, failover across providers, image/context compression, prompt caching, account-usage tracking — all production-hardened. **40-60 h.**
2. **Wire Telegram adapter** (`plugins/platforms/telegram/adapter.py`) to ingest into AI OS as a new run source. BotFather setup, `TELEGRAM_BOT_TOKEN` env, route inbound DMs → `runs` table with `source=telegram`. Phone control of AI OS without the V2 web UI. **12 h.** (Discord/Slack same shape, +6 h each.)
3. **Lift `ModelsPage.tsx` + `PluginsPage.tsx`** as full pages → AI OS surfaces for claude-pool slots and Skill registry browser. Replaces our weak Models tab. **20 h.**

**Gain:** AI OS becomes a battle-tested agent runtime with multi-channel ingress; Konrad can text his AI OS from anywhere. **VPS impact:** +1 PM2 process (~1 GB RAM), +3 GB disk for venv, slight CPU bump from streaming loop. Comfortable on current hardware. **Risk:** Python/TS bridge adds debugging surface; two source-of-truth risk if executor logic drifts between TS forge-executor and Python sidecar — pick one.

### Recommendation: **Tier 2**

Tier 3's Python sidecar means maintaining two executors forever; the gain (failover, prompt-cache discipline) is real but we get most of it by porting key concepts to TS. Tier 2 hits the high-leverage wins (thread compression for Opus 1M, webhooks surface, skill curator) without splitting the brain.

**Concrete next-step lifts (Tier 2):**

- `web/src/lib/slashExec.ts` → `apps/hermes-workspace/src/screens/chat/slash-exec.ts`
- `web/src/components/SlashPopover.tsx` → `apps/hermes-workspace/src/screens/chat/SlashPopover.tsx`
- `web/src/lib/fuzzy.ts` → `apps/hermes-workspace/src/lib/fuzzy.ts`
- `trajectory_compressor.py` (algorithm only) → `apps/hermes-control-plane/src/lib/thread-compressor.ts`
- `web/src/pages/WebhooksPage.tsx` + `CronPage.tsx` + `components/ScheduleBuilder.tsx` → `apps/hermes-workspace/src/screens/{webhooks,cron}/`
- `agent/curator.py` (pattern + state-machine) → `apps/hermes-control-plane/src/services/skills-curator.ts`
