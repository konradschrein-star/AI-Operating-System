# AI-Operating-System

An AI operating system that runs like a business partner — with the goal of running a whole company autonomously.

This repository is the system itself: the control plane, the web interface, the agent roles, and the
execution engine that lets a fleet of Claude agents plan, build, verify and ship work without a human
babysitting each step. It is deployed on a Hetzner VPS and supervised by pm2; the same repo is what the
agent edits when it improves itself.

## Layout

| Path | What it is |
| --- | --- |
| `forge-control/` | Backend control plane (TypeScript, Node 22, tsx). REST API on `127.0.0.1:7700` plus the executor process that actually runs agent turns. |
| `forge-control-web/` | Next.js interface — chat rail, Kanban, live worker panes, canvas, mobile view. |
| `forge-control-mcp/` | MCP server exposing the control plane to other agents. |
| `agents/` | Role definitions: `architect`, `planner`, `builder`, `reviewer`, `researcher`, `scout`. Each pins a model tier and toolset. |
| `db/migrations*` | PostgreSQL schema for runs, projects, tasks, memory, ledger. |
| `docs/` | Specs, research, and versioned design notes (`ai-os-v16`, `ai-os-v17`, `plan/`). |
| `scripts/` | Operational helpers — health checks, MCP wiring, benchmarks, sync, imports. |
| `vault-seed/` | Starting structure for the Obsidian vault the OS reads and writes. |

## Processes

Two pm2 services carry the system:

- **`forge-control`** — `forge-control/src/index.ts`, the API.
- **`forge-executor`** — `forge-control/src/executor.ts`, the agent runner.
- **`forge-control-web`** — the Next.js UI.

## API surface

Routes live in `forge-control/src/routes/`. The ones used most often:

- `GET /api/today`, `GET /api/vault/*` — daily note and Obsidian vault access
- `GET /api/memory/search?q=` — vector + graph search over the indexed vault
- `POST /api/projects` — start a coding project (seeds an architect task; `architect_tier` picks its model)
- `POST /api/reminders` — `{"text","when"}`, where `when` accepts `in 2h`, `tomorrow 9:00`, `daily 08:30`
- `/api/chat`, `/api/run-control`, `/api/fleet`, `/api/live` — conversations, run lifecycle, worker fleet
- `/api/pm2`, `/api/systemd`, `/api/health`, `/api/spend` — operations and cost

## Design principles

1. **Durable over ephemeral.** Work is delegated to the projects fleet, which survives session cycles, rather than to in-process subagents that die with their parent.
2. **Search before answering.** Anything touching Konrad's life, projects or decisions is answered from the vault, not from training data.
3. **The chat is the surface.** Every conversation is a manager chat; the Kanban and side panels are scoped to whichever chat is open.
4. **Irreversible actions escalate.** Destructive operations need an explicit instruction in the current task.

## Stack

Node 22 · TypeScript · Next.js · PostgreSQL · Redis/BullMQ · pm2 · nginx · Claude Opus 5 via the Claude Agent SDK.

## License

See `LICENSE`.
