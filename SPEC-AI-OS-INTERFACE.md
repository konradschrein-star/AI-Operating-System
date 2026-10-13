# Spec — Personal AI OS Interface

**Written:** 2026-06-14
**For:** Claude (claude.ai design / canvas) to produce a UI design from
**Owner:** Konrad Schrein
**Synced to:** `/opt/hermes-control/SPEC-AI-OS-INTERFACE.md` (VPS, Hermes git) and `/opt/obsidian-vault/Spec - Personal AI OS Interface.md` (Obsidian vault)
**Read first:** `Infrastructure - Master Map.md` — the substrate this UI sits on top of

---

## 1. Purpose

Konrad runs a single Hetzner VPS (`65.108.6.149`) that hosts **three concentric layers** of infrastructure: an agentic OS (Hermes — Python supervisor + tmux Claude fleet), a YouTube content factory (Content Forge — Postgres + BullMQ + FFmpeg), and a constellation of ~10 side-product apps. Today the only interfaces are SSH, a thin Flask agent-dashboard (port 9191, unexposed), and per-app web UIs scattered across nginx subdomains. There is **no single pane of glass.**

This spec describes the personal AI OS interface — a single web application that becomes Konrad's **primary daily interaction surface** with the entire system. It replaces the current "open a terminal and SSH in to figure out what's happening" workflow with a unified dashboard + chat experience, and it replaces the current "open Claude Code in a PowerShell window" workflow with an in-browser chat agent that has the same tool-use capabilities as Claude Code but in a richer, persistent, multi-pane environment.

**Obsidian is excluded from scope** — it remains Konrad's personal note-taking app for learning. The AI OS interface and Obsidian coexist; they sync the same vault via the existing CouchDB LiveSync, but neither owns the other.

---

## 2. What it observes and controls

The interface is a **read + control surface** over these live systems (all on `65.108.6.149`):

### 2a. Hermes — the agentic OS

- Python supervisor at `/opt/hermes-control/supervisor.py` runs as `hermes-supervisor.service` (systemd, 30s tick)
- SQLite ledger at `/opt/hermes-control/control.db` — tables: `workers`, `heartbeats`, `tasks`, `events`
- Fleet: 5 long-lived `claude -p` workers in tmux sessions on the default socket (`/tmp/tmux-0/default`), inheriting OAuth from `/root/.claude/.credentials.json` — current roster: `cc-architect`, `cc-docs`, `cc-writer-01`, `sysop-01`, `cc-test-02`
- Task injection by dropping `<id>.json + .md + .sh` into `/opt/hermes-control/queued/` — supervisor uses `tmux send-keys` to dispatch
- Worker self-reports via `worker_manager.py heartbeat-report` → appends row to `heartbeats`

### 2b. Content Forge — the video factory

- PM2-managed (`hub-web`, `worker-orchestrator`, `worker-render`, `worker-video-stitch`, `forge-api`, `audio-face-sidecar`, `vlm-sidecar`, `claude-pool`)
- Postgres on `127.0.0.1:5434` — main table `content_jobs` runs a ~40-state state machine (IDEA_GENERATION → SCRIPTING → TTS → ASSET_COLLECTION → ROUTING_RENDER → RENDERING → AWAITING_UPLOADER → PUBLISHED)
- Redis/BullMQ on `127.0.0.1:6382` — queue isolation: `queue:ingest`, `queue:ai-generation`, `queue:qms-validation`, `queue:render-heavy`, `queue:dead-letter`, etc.
- Hub Web on `0.0.0.0:3000` (operator dashboard, RBAC for 5 roles)
- Public: `hub.schreinercontentsystems.com`, `forge-api.schreinercontentsystems.com`

### 2c. The constellation (each is its own product/tool with its own UI)

| App                       | Path                                                 | Public URL                                              | What                                         |
| ------------------------- | ---------------------------------------------------- | ------------------------------------------------------- | -------------------------------------------- |
| Keyword Tool V2           | `/opt/keyword-tool-v2/`                              | `keywordtool.schreinercontentsystems.com`               | YouTube keyword research                     |
| Thumbnail Generator       | `/opt/thumbnail-generator/`                          | `thumbnails.schreinercontentsystems.com`                | AI thumbnail factory                         |
| Reelforge                 | `/opt/reelforge/`                                    | `reelforge.schreinercontentsystems.com`                 | Short-form video product                     |
| Suno Automation           | `/opt/suno-automation/`                              | —                                                       | Music gen                                    |
| Portfolio Wiki            | `/opt/portfolio-wiki/`                               | —                                                       | Portfolio site                               |
| ShiftSync (SaaS)          | `/opt/schichtkommunikationstool/`                    | `schichtkommunikationstool.schreinercontentsystems.com` | Construction shift comms (client product)    |
| VEO API                   | `/opt/veo-api/` + residential workers `veo-resi@0/1` | —                                                       | Google Veo video gen via residential proxies |
| Plane (issues)            | `/opt/plane/`                                        | `plane.schreinercontentsystems.com`                     | Self-hosted issue tracker                    |
| Aryan eBook               | —                                                    | `aryan-ebook.schreinercontentsystems.com`               | Client deliverable                           |
| Schreiner Content Systems | —                                                    | `schreinercontentsystems.com`                           | Brand site                                   |

### 2d. Shared AI infrastructure

- **Gemini Pool** on `gemini-api.service`, residential SOCKS5 egress on `gemini-socks.service`
- **Claude Pool** at `apps/claude-pool/` on `:8092` (self-hosted Claude Opus 4.7)
- **Ollama** on `127.0.0.1:11434`
- **Image gen API** on `:8003` (Nano Banana 2 / Gemini)
- **MCP servers**: `knowledge-mcp` (PM2 `knowledge-indexer-watch`), `cf-mcp-server`, `hcp-mcp-server`

### 2e. Obsidian (read-only from this UI)

- Vault at `/opt/obsidian-vault/` (49 markdown files)
- CouchDB LiveSync at `obsidian-sync.schreinercontentsystems.com` (CouchDB v3.5.1 on `127.0.0.1:5984`)
- Synced to Konrad's laptop at `D:\Obsidian\VPS Obsidian\Konrad\Konrad\`

---

## 3. The three primary surfaces

The UI has exactly three top-level destinations. Everything else is sub-navigation underneath these.

### 3a. **Live** — the "what's happening right now" surface (the default landing view)

A single-screen, glanceable display answering five questions in five rows:

1. **Hermes fleet** — each `cc-*` worker as a card: name, role, current state (`idle` / `running` / `blocked` / `needs-input` / `done`), current task description (one-liner from heartbeat `progress`), CPU%, last 3 lines of tmux pane output. State color: idle (gray), running (orange `#ff8c00` per the existing agent-dashboard aesthetic), blocked (red), needs-input (yellow pulse), done (green). 5 cards in a horizontal strip.
2. **Content Forge jobs** — every `content_jobs` row not in a terminal state, grouped by state. Compact horizontal swim-lanes (one per major state group: Pre-render → Render → Upload). Click a card → drill into job detail.
3. **Service health** — PM2 + systemd + docker, colored by status. 17 PM2 services + ~12 named systemd units + docker containers. Grid of small badges; red badges float to top; click → log tail.
4. **Side-apps activity** — for each constellation app, a single number: most-recent-action timestamp, rough activity in last 24h (request count from nginx access log, jobs created, whatever's cheapest to compute). Card per app; click → app's own UI in a new tab.
5. **System resources** — CPU, memory, disk %, swap. Sparkline last 1 hour. Anomalies (>80% sustained) highlighted.

This is the **wallpaper view.** Designed to be left open on a second monitor. Auto-refreshes every 5s (polling, not realtime — see § 7).

### 3b. **Chat** — the AI agent with tools (Claude Code, but better)

Functionally equivalent to the Claude Code CLI Konrad uses today, but in a persistent web environment with:

- **Conversation persistence** — every chat saved to Postgres, searchable, resumable across devices
- **Multi-pane** — chat on the left, the agent's current action context (file tree, terminal output, diffs) on the right
- **Tool-use surfacing** — when the agent calls a tool, the right pane reflects it (running a shell command → shell pane; reading a file → file view; editing → diff view)
- **Shared context with Live** — chat agent can see the Live dashboard's data without re-querying; Konrad can right-click any Live card → "Ask in chat about this"
- **Workspace switcher** — top of chat: "current focus", e.g. "Content Forge" / "Hermes Ops" / "Axtrelis client X" — narrows which projects the agent reaches into (changes default cwd + file scope)

The agent itself runs on the VPS — not a hosted service. Recommended backend: a dedicated `claude -p` instance (same pattern as Hermes workers, no token costs, full tool access). Frontend talks to it via WebSocket + HTTP.

Detailed agent capability list: § 5.

### 3c. **Map** — the cross-system index

A queryable view across all three layers. Three sub-tabs:

- **Tasks** — every Hermes task (from `tasks` table), every Content Forge job (`content_jobs`), every VEO generation, every Plane issue. Unified columns: `system`, `id`, `title`, `state`, `assignee`, `created`, `updated`. Filterable, sortable, full-text searchable.
- **Files** — every file Konrad cares about: `INFRASTRUCTURE.md`, `SPEC-*.md`, project READMEs, Obsidian notes, the most-recent rendered video output. Indexed by `knowledge-indexer-watch` (already running). Search box. Click → opens in a side panel with markdown rendering.
- **History** — append-only log of significant events: deploys, worker spawns, task completions, error spikes, jobs published. Sourced from Hermes `events` table + nginx access logs + git activity. Scrollable timeline.

---

## 4. Information architecture

```
┌──────────────────────────────────────────────────────────────┐
│  TOP BAR                                                     │
│  [Logo]  Live  |  Chat  |  Map     [workspace ▼]  [user ▼]   │
├──────────────────────────────────────────────────────────────┤
│                                                              │
│                  CONTENT PANE                                │
│  (renders one of: Live dashboard / Chat / Map)               │
│                                                              │
│                                                              │
├──────────────────────────────────────────────────────────────┤
│  STATUS BAR (always visible)                                 │
│  [● 5/0 fleet]  [● 17/19 PM2]  [⚠ 1 stuck job]  [v1.2.3]    │
└──────────────────────────────────────────────────────────────┘
```

- **No sidebar.** Everything sub-navigates under the three top-level destinations.
- **Status bar** is the persistent reduce-to-one-glance bar. Click any pill → drills into the relevant Live row. Anomalies surface here even when on Chat or Map.
- **Workspace switcher** in top bar scopes Chat's default reach (cwd, file filters) but doesn't filter Live or Map by default.
- **Keyboard-first.** `g l` / `g c` / `g m` for Live / Chat / Map; `/` to focus search; `?` for help; `Esc` cancels mid-action.

---

## 5. The Chat agent — capabilities

The chat agent has the same tool-use shape as Claude Code. From the user's perspective: open chat, ask a question or give a task, the agent uses tools to read/write/run, and reports back. From the system's perspective: a `claude -p` process on the VPS with a custom tool registry exposed via a JSON-RPC layer the frontend can monitor.

### Tools exposed to the agent

| Category        | Tool                                                                                                                            | Notes                                                                                                |
| --------------- | ------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------- |
| Filesystem      | `read_file`, `write_file`, `edit_file`, `list_dir`, `glob`, `grep`                                                              | Across VPS filesystem; respects a deny-list (e.g., `/root/.claude/.credentials.json`, `/etc/shadow`) |
| Shell           | `run_bash`, `run_powershell_via_winvm` (for the noVNC Win11 VM at `:6080`)                                                      | Streaming output to the right pane; long-running commands report progress                            |
| Git             | `git_status`, `git_diff`, `git_commit`, `git_push`                                                                              | Across all repos under `/opt/*/.git` and `/opt/repos/`; respects `~/.gitconfig`                      |
| Hermes          | `inject_task(worker_id, brief, role)`, `list_workers()`, `read_heartbeats(worker_id)`, `tail_pane(worker_id)`                   | Wraps `worker_manager.py`                                                                            |
| Content Forge   | `create_job(format, channel, metadata)`, `list_jobs(filter)`, `get_job(id)`, `pause_job(id)`, `resume_job(id)`, `retry_job(id)` | Wraps existing Hub Web API endpoints                                                                 |
| Postgres        | `query_postgres(sql)`                                                                                                           | Read-only by default; write requires explicit user confirmation in chat                              |
| SQLite (Hermes) | `query_sqlite(sql)`                                                                                                             | Read-only by default                                                                                 |
| Process         | `pm2_list()`, `pm2_logs(name, lines)`, `pm2_restart(name)`, `systemctl_status(unit)`, `journalctl(unit, since)`                 | systemctl write ops gated by confirmation                                                            |
| Web             | `web_fetch(url)`, `web_search(query)`                                                                                           | Outbound HTTPS                                                                                       |
| Obsidian        | `read_note(name)`, `write_note(name, content)`, `list_notes(tag)`                                                               | Writes go to `/opt/obsidian-vault/`; LiveSync propagates to Konrad's laptop within seconds           |
| MCP             | Bridges to existing MCP servers: `knowledge-mcp`, `cf-mcp-server`, `hcp-mcp-server`                                             | Pass-through                                                                                         |
| Self            | `remember(category, note)` — appends to `/opt/claude-memory/` (persistent across sessions)                                      | Same idea as Claude Code's auto-memory                                                               |

### Tool-use surfacing in the right pane

- `read_file` → render the file with syntax highlighting; highlight the section the agent is focused on
- `edit_file` → diff view (red/green), with "Approve" / "Reject" / "Edit further" buttons if Konrad wants to gate it
- `run_bash` → live-streaming terminal pane (xterm.js)
- `query_postgres` → result table
- `inject_task` → preview the Markdown brief before dispatch; "Confirm dispatch to cc-architect" button
- `web_fetch` → readable HTML render in the side pane

### Approval model

Two modes:

- **Trusted mode** (default for Konrad): agent runs tools without per-call approval. Right pane shows what happened.
- **Reviewed mode** (opt-in per conversation): every tool call shows a confirm/deny prompt before running. Useful for sensitive ops.

The agent always confirms before:

- Writing/deleting outside the working set (`/etc/`, `/root/`, `/opt/backups/`)
- Destructive shell commands (`rm -rf`, `DROP TABLE`, `pm2 delete`, `systemctl disable`)
- Pushing commits or merging to `main`
- Spending money (calling paid APIs above a per-conversation cap)

Approval prompts are inline in the chat — not modals — so the conversation reads naturally.

### Memory & context

- **Per-conversation memory** in Postgres (conversation history, attached files, tool calls)
- **Persistent personal memory** at `/opt/claude-memory/MEMORY.md` (same format as Claude Code's auto-memory; the agent appends `user`, `feedback`, `project`, `reference` memories there)
- **Project memory** — when a workspace is selected, the agent reads `<project>/CLAUDE.md` first
- **MCP integration** — `knowledge-mcp` provides vector search over the Obsidian vault, the codebases, and historical conversations

---

## 6. Data sources & polling

The interface reads from these endpoints. Most are cheap polls; only the chat agent and the live tmux pane tail need realtime.

| Source                  | Endpoint / Method                                                                         | Refresh   | Used by                                             |
| ----------------------- | ----------------------------------------------------------------------------------------- | --------- | --------------------------------------------------- |
| Hermes workers          | `sqlite3 /opt/hermes-control/control.db` (over a thin Python HTTP wrapper or direct read) | 5s        | Live §3a row 1                                      |
| Hermes heartbeats       | Same DB, `heartbeats` table                                                               | 5s        | Live §3a row 1, Map → History                       |
| Hermes events           | Same DB, `events` table, ORDER BY created_at DESC LIMIT 100                               | 5s        | Map → History                                       |
| Tmux pane tail          | `tmux -S /tmp/tmux-0/default capture-pane -t cc-<id> -p` last 3 lines                     | 5s        | Live §3a row 1                                      |
| Tmux pane stream (full) | `tmux pipe-pane` → WebSocket relay                                                        | realtime  | Chat right-pane "watch worker live" view            |
| Content Forge jobs      | Postgres `SELECT * FROM content_jobs WHERE status NOT IN (terminal_states)`               | 5s        | Live §3a row 2                                      |
| Content Forge events    | `system_events` table + LISTEN/NOTIFY                                                     | realtime  | Live §3a row 2 (state transitions push immediately) |
| PM2 list                | `pm2 jlist` (cached via wrapper)                                                          | 10s       | Live §3a row 3, Status bar                          |
| systemd units           | `systemctl list-units --type=service --no-legend` parsed                                  | 30s       | Live §3a row 3                                      |
| Docker containers       | `docker ps --format json`                                                                 | 30s       | Live §3a row 3                                      |
| nginx access logs       | tail of `/var/log/nginx/access.log` filtered per vhost                                    | 10s       | Live §3a row 4                                      |
| System resources        | `/proc/loadavg`, `/proc/meminfo`, `df -h /opt`, `vmstat 1 1`                              | 5s        | Live §3a row 5                                      |
| Knowledge MCP search    | HTTP to `knowledge-mcp` server                                                            | on-demand | Map → Files search box                              |
| Obsidian vault          | `/opt/obsidian-vault/*.md` (read directly, watch via inotify)                             | inotify   | Map → Files, Chat tool `read_note`                  |

A single Node service (the **`forge-control`** backend, see § 9) aggregates all of these. Frontend talks to one WebSocket + a small REST surface; the Node service handles caching, fan-out, and source-specific polling.

---

## 7. Realtime vs eventual

**Server-to-client:**

- **WebSocket channel** carries: chat tokens, tool-call events, Postgres `LISTEN/NOTIFY` deltas, system-event pushes, tmux pipe-pane streams when a "watch worker live" pane is open.
- **HTTP polling** for everything else, on a 5/10/30s schedule per § 6.
- The mix is deliberate: WebSocket where the latency matters (chat, state transitions, live terminal), polling where it doesn't (PM2 list, system resources). One persistent socket per session is enough.

**Server-to-laptop / cross-device:**

- VPS is the authoritative source of truth. Laptop accesses the UI by loading it from the VPS (no local replica of the application state).
- The web UI itself works offline-friendly for **reading** (recent state cached in IndexedDB), but actions (tool calls, chat messages) require an open connection.
- Obsidian vault sync is the only cross-device persistence layer — it carries notes and the agent's `Spec - *.md`, `Infrastructure - *.md`, and `Brainstorm - *.md` artifacts.

---

## 8. Auth & security

Single user (Konrad). No RBAC, no multi-tenancy.

- **Login**: GitHub OAuth (Konrad's `konradschrein-star` account). One allowed user. Sessions live for 30 days, refreshed.
- **2FA**: required (GitHub already enforces it for Konrad).
- **HTTPS only**: behind nginx, Let's Encrypt cert (the existing cert infra).
- **The chat agent runs as `root`** on the VPS — same trust model as Claude Code on a personal machine. The approval model in § 5 is the safety belt.
- **Public URL**: `console.schreinercontentsystems.com` (new subdomain).
- **Audit log**: every tool call (especially writes/destructive ops) appended to `/opt/claude-memory/AUDIT.log` with timestamp + conversation ID + outcome.
- **Secrets**: never displayed in the UI. `read_file` on `/root/.claude/.credentials.json`, `/opt/obsidian-livesync/.env`, etc. returns `[REDACTED]`. Deny-list configurable in a settings note.

---

## 9. Tech stack recommendation

> All choices below are **defaults Konrad can override**. Rationale given so the design can argue back.

| Layer                       | Recommendation                                                                                                                                                                      | Why                                                                                                                                                                        |
| --------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Frontend**                | **Next.js 15 App Router + React 19**                                                                                                                                                | Matches 7 of 9 active Konrad projects per `Konrad Projects Overview.md`. Server Components let the dashboard render server-side against the VPS DBs without exposing them. |
| **Styling**                 | **Tailwind CSS** + a minimal token-driven theme (orange `#ff8c00` accent matching existing `agent-dashboard`, dark base `#0d0d0d`, JetBrains Mono for code)                         | Established aesthetic; the existing Flask agent-dashboard's `index.html` already converged on this palette.                                                                |
| **UI components**           | **shadcn/ui** + custom monospace-heavy variants                                                                                                                                     | Lightweight, themeable, paste-not-install model fits Konrad's other projects.                                                                                              |
| **State / data fetching**   | **TanStack Query** for polling sources; **native WebSocket** for the realtime channel                                                                                               | TanStack Query handles cache + revalidation cleanly; no need for a heavyweight realtime framework like SignalR.                                                            |
| **Backend (aggregator)**    | **Node 22 + Hono on `:7700`**, deployed via PM2 as `forge-control`                                                                                                                  | Hono is already in use (`hermes-control-plane`). Light, fast, easy to deploy.                                                                                              |
| **Agent process**           | **`claude -p` worker** spawned via Hermes's existing `worker_manager.py` pattern, role `console-agent`, project_dir `/`, with a custom MCP server bridging the tool registry of § 5 | Reuses the OAuth + tmux + heartbeats infrastructure; zero token cost; full tool reach.                                                                                     |
| **Storage**                 | Postgres (existing on `:5434`) for chat history, conversations, audit                                                                                                               | Already there. Add a `console` schema.                                                                                                                                     |
| **Frontend chat transport** | WebSocket from browser → `forge-control` → MCP bridge → `claude -p` worker stdin/stdout                                                                                             | Three-hop sounds heavy but each hop is local; latency dominated by Claude itself.                                                                                          |
| **Auth**                    | **NextAuth.js** with GitHub provider                                                                                                                                                | Standard; integrates with Next.js App Router.                                                                                                                              |
| **Deploy**                  | PM2-managed `forge-control` (backend) + Next.js standalone (`forge-control-web`); nginx vhost for `console.schreinercontentsystems.com` → `127.0.0.1:7701`                          | Mirrors hub-web's pattern.                                                                                                                                                 |

### What NOT to use

- ❌ **A new orchestration framework** (LangGraph, CrewAI, Mastra). Hermes is the orchestrator. The Console is a UI over Hermes.
- ❌ **A second database for the dashboard.** Read from the existing Postgres + SQLite. The Console owns one new `console` schema for its own chat / audit, nothing else.
- ❌ **A SaaS chat backend** (OpenAI Assistants, Anthropic Agents API). The VPS already runs Claude via OAuth at zero marginal cost. Use that.
- ❌ **Realtime everything.** WebSocket where latency matters (chat, state transitions, live tmux); polling for the rest. Don't pay the complexity tax for things that change once a minute.

---

## 10. Phasing

### Phase 1 — MVP "see the system" (target: 1 week)

Only the **Live** destination. No chat. Goal: replace the SSH-and-grep workflow.

- Backend: `forge-control` Hono service reads Hermes SQLite + Postgres + PM2 jlist, exposes one REST endpoint per § 6 source
- Frontend: Next.js app with just the Live page, status bar, polling every 5/10/30s
- Auth: NextAuth GitHub OAuth, single-user allowlist
- Deploy: PM2 + nginx vhost
- Success: Konrad opens `console.schreinercontentsystems.com` on his laptop, sees the fleet + Content Forge jobs + service health in one page, never SSHs in to check status again

### Phase 2 — chat with tools (target: 2 weeks after Phase 1)

- Spawn a dedicated `claude -p` agent worker (role `console-agent`) via Hermes
- MCP bridge exposing the tool registry of § 5
- Chat panel UI: left chat, right tool-action pane
- Conversation persistence in Postgres
- Approval model + audit log
- Success: Konrad opens the Chat tab on the laptop, types "What's the state of the asset-collection queue?" and gets the answer + ability to follow up with "OK, retry the stuck one" — same UX as Claude Code today

### Phase 3 — Map + cross-system search (target: 1-2 weeks after Phase 2)

- Unified Tasks view across Hermes / Content Forge / Plane
- Files view powered by `knowledge-mcp`
- History timeline
- Right-click on Live cards → "Ask in chat"
- Workspace switcher
- Success: Konrad can find any past job, any past conversation, any note, any commit, in one search box

### Phase 4 — quality of life (open-ended)

- Mobile-responsive layout (read-only on phone is fine; chat on phone is bonus)
- Push notifications for failed jobs / blocked workers / cost alerts
- Multi-workspace agent (parallel chats with the agent on different focuses)
- Tool registry user-editable via UI
- VEO browser-farm controls (once Xvfb is fixed — see open issues in `INFRASTRUCTURE.md`)

---

## 11. Open decisions (Konrad picks before implementation starts)

1. **One agent or many?** Phase 2 spec assumes one console-agent worker. Alternative: a pool of 2-3 console-agents so multiple conversations can run in parallel. Cost: more memory; benefit: snappier multitasking. (Recommendation: one for MVP, expand if needed.)
2. **Chat history visibility — across devices?** If Konrad's on his laptop and asks a question, then opens the phone, should he see the same conversation continuing? (Recommendation: yes, conversations are server-side; client just connects to them.)
3. **The Win11 VM / noVNC** — should the Console embed the noVNC viewer (so the Win11 VM is reachable from inside the dashboard), or stay separate? (Recommendation: separate for MVP; embed in Phase 4.)
4. **Public URL for the Console** — `console.schreinercontentsystems.com`? Or hide it under a path on an existing domain so it's not discoverable by URL scanning? (Recommendation: dedicated subdomain; fail2ban + OAuth-required is enough.)
5. **Theming flexibility** — strict to the orange-on-black `#ff8c00 / #0d0d0d` palette, or let Konrad theme it later? (Recommendation: design with two themes from day one — dark default, optional light for outdoor laptop use.)
6. **Action confirmation default** — Trusted (auto-run) or Reviewed (per-call approval) as default for new conversations? (Recommendation: Trusted, with Reviewed togglable per conversation.)
7. **Mobile MVP scope** — Phase 1 mobile = read-only Live view, or skip mobile until Phase 4? (Recommendation: read-only Live in Phase 1 since it's cheap; chat on mobile waits.)

---

## 12. Constraints & non-goals

**Constraints that bind the design:**

- Must run alongside the existing 19-service PM2 fleet without conflicting (new ports: `:7700` backend, `:7701` web; new PM2 names: `forge-control`, `forge-control-web`)
- Must not break the existing `agent-dashboard` on `:9191` — it stays as a fallback / legacy debug surface
- Must read existing Postgres/SQLite without schema changes (the Console adds its own `console` schema only)
- Must use the existing nginx + Let's Encrypt setup (no new TLS infra)
- Must use the existing claude-pool/Claude OAuth on the VPS (no Anthropic API tokens)
- Must respect Obsidian vault conventions (`Vault Guide.md`) when writing notes — frontmatter required, kebab-case filename categories per § 2.4 of the vault guide

**Explicit non-goals:**

- ❌ Replacing any existing per-app UI (Keyword Tool, Thumbnail, etc. keep their own UIs; the Console aggregates _over_ them)
- ❌ Multi-user / RBAC (Konrad is the only user; auth is single-allowlist OAuth)
- ❌ Hosting on Vercel or any cloud platform (everything on the VPS — eventual sync to laptop, see § 7)
- ❌ Replacing Obsidian (Obsidian remains the personal note-taking tool; Console is for _operating_ the system)
- ❌ Replacing Plane (issue tracking stays on Plane; the Console _reads_ Plane issues into the Map view but doesn't try to be a tracker)
- ❌ Mobile-first (Konrad's primary device is the laptop with a second monitor; mobile is bonus)

---

## 13. Visual & interaction principles

For the Claude design pass:

- **Dense, glanceable, monospace-leaning.** Konrad reads code and logs all day. Spacious "design app" aesthetics are wrong here. Think Datadog × xterm × Obsidian.
- **Color is signal, not decoration.** Green = healthy, yellow = attention, red = bleeding, orange = active/working. Most of the UI should be near-monochrome (`#cdc3d7` text on `#0d0d0d` background) so color stands out.
- **JetBrains Mono everywhere except chat prose.** Identifiers, paths, ports, IDs, timestamps — all monospace. The chat agent's responses use a proportional font (Inter or system-ui) for readability of natural language.
- **Keyboard-first.** Every action reachable without mouse. Visible shortcut hints (`?` opens cheat sheet).
- **No modals.** Every dialog is an inline expansion or a side panel. Modals interrupt; expansions flow.
- **Always-visible status bar** (per § 4). Konrad should never not-know that something is bleeding.
- **Right-pane is sticky.** Once an action is in the right pane, it stays there until Konrad dismisses it or starts a new action. Reduces "where did that output go?" cognitive load.
- **Dark by default, gracefully light.** Orange `#ff8c00` is the accent in both themes; dark surface is `#0d0d0d`, light surface is `#fafafa`. Use the same component primitives; only tokens swap.

---

## 14. Appendix — the substrate this UI replaces

What Konrad does today, that the Console replaces:

| Today                                                                                        | After Console                                                                   |
| -------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------- |
| SSH in, `tmux ls`, `pm2 list`, `sqlite3 control.db "SELECT..."` to check fleet               | Open `console.schreinercontentsystems.com` → Live                               |
| Open PowerShell + Claude Code to do file ops + run commands                                  | Open Chat tab; same agent, same tools, persistent history                       |
| Search "where was that note about Gemini Pool?" by file-grep across `/opt`                   | Map → Files → "Gemini Pool"                                                     |
| Find out a job is stuck by noticing the video didn't appear on YouTube                       | Status bar shows "⚠ 1 stuck job" the moment it stalls                           |
| Read 60MB of `supervisor.log` to see why a worker died                                       | Map → History → click event → narrow timeline                                   |
| Manually drop a JSON+MD+SH triplet into `/opt/hermes-control/queued/` to dispatch a task     | Chat: "Dispatch X to cc-architect" → agent injects via tool, shows confirmation |
| Open three browser tabs (hub.scs, keywordtool.scs, plane.scs) to check on different products | One tab. Side-apps row in Live links out when Konrad wants a specific app's UI. |

---

_This spec is the design brief, not the implementation plan. Once approved, the implementation plan lives at `docs/superpowers/specs/2026-06-XX-personal-ai-os-interface-plan.md` and tracks per-phase milestones._
