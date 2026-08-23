# AI OS Development & Engineering Guide

This document is the authoritative engineering guide for developers and autonomous agents working on Konrad's Personal AI OS (`forge-ai-os`). It defines the environment constraints, worktree workflows, file ownership rules, verification gates, screenshot protocols, and the unified `aios` CLI toolchain.

---

## 1. Environment & Architecture Overview

The AI OS architecture consists of two primary applications and supporting infrastructure:

- **`forge-control` (Backend API — port 7700)**: TypeScript/Hono service managing background agents, projects, tasks, execution runs, vault synchronization, and Content Forge integrations.
- **`forge-control-web` (Frontend Desktop Web App — port 7701)**: Next.js 15 App Router application rendering the desktop workstation interface (`/desktop`). Surfaces are dynamically switched via client state.
- **`aios` CLI (`forge-control/bin/aios.mjs`)**: Unified command-line interface wrapping the live `:7700` API, pre-merge code guard, screenshot harness, and terminal execution.
- **`scripts/checks/` & `scripts/deploy/`**: Automated verification gates, code guard suite, token purity checkers, and deployment runners.

---

## 2. Worktree Setup & Dependency Management

Development on `forge-ai-os` occurs strictly inside isolated Git worktrees. Never edit the live checkout at `/opt/forge-ai-os` during build phases.

### The `NODE_ENV=production` Installation Gotcha
The runtime environment defaults to `NODE_ENV=production`. Under this setting, standard package manager commands silently prune `devDependencies` (including `typescript` and `tsx`), report "Already up to date", and exit `0`. Subsequent typechecks fail with `tsc: not found`.

**Mandatory Dependency Rule**:
Always install dependencies with explicit production flag overrides using `pnpm`:
```bash
# In forge-control:
cd forge-control && pnpm install --frozen-lockfile --prod=false

# In forge-control-web:
cd forge-control-web && pnpm install --frozen-lockfile --prod=false
```
> **Warning**: Never run bare `pnpm install --frozen-lockfile` or `pnpm add` without `--prod=false`, as it will prune TypeScript and break local execution tooling.

### Never Boot the Full Backend Entrypoint in Worktrees
Do **not** run `tsx src/index.ts` from a worktree. The backend entrypoint loads production secrets and connects live Telegram bot webhooks (`getUpdates` conflict) and production knowledge embeddings.
- To test isolated routes, use dedicated micro-servers (such as `scripts/checks/serve-v3-7798.ts`) mounted on throwaway ports.
- To inspect data shapes, query the already-running live API on `:7700` read-only.

---

## 3. Blast Radius & Strict File Ownership Rules

When parallel agent lanes or developers modify this repository, file ownership boundaries prevent destructive merge conflicts.

### Strictly Forbidden Shared Files
Unless a task brief explicitly assigns ownership of these specific files, **do NOT edit**:
- `forge-control-web/app/desktop/DesktopApp.tsx` (Root shell & rail layout)
- `forge-control-web/app/desktop/nav-items.ts` (Global surface navigation registry)
- `forge-control-web/app/tokens.ts` (Design token definitions)
- `forge-control-web/app/globals.css`, `app/theme.css`, `app/v2.css` (Global stylesheets)
- Core engine files (`project-tick`, `cc-runner`, `executor.ts`, `db/projects`, `VaultFileList`, `routes/files`)

### The `HANDOFF.md` Protocol
If a feature strictly requires changes to a shared file owned by another lane:
1. Do not modify the forbidden file in your branch.
2. Implement your component/service self-contained in your own domain directory.
3. Record the exact needed integration line or schema adjustment in `HANDOFF.md` at the repository root.

### 100% Token Compliance (No Raw Colours)
- Every color in `forge-control-web/app/` must resolve through `app/tokens.ts`.
- Raw hex codes (`#123456`), `rgb()`, `rgba()`, `hsl()` literals with hardcoded values are prohibited because they break light/dark theme switching outdoors.
- If a component paints into a non-DOM canvas or WebGL context (e.g., `MemoryGraph3D.tsx`), it must be documented in `scripts/checks/raw-colour-allowlist.txt`.

---

## 4. Code Guard & Pre-Merge Verification

All code must pass the unified code guard before merging. The guard enforces static rules, token purity, forbidden file diffs, high-speed typechecking, and functional suites.

### Running the Guard
```bash
# Fast guard (Phases 0-2: Node version, devdeps, no-raw-colours, dollar-sweep, forbidden-files, tsc):
bash scripts/checks/guard.sh --fast
# Or via CLI:
aios guard fast

# Full pre-merge guard (Phases 0-4: Includes web production build and full gates-808 suite):
bash scripts/checks/guard.sh --full
# Or via CLI:
aios guard full

# Strict mode (Fails on any skipped check):
bash scripts/checks/guard.sh --full --strict
aios guard strict

# Machine-readable JSON report:
bash scripts/checks/guard.sh --fast --json
```

### Guard Phase Breakdown
| Phase | Name | Scope & Purpose |
|---|---|---|
| **Phase 0** | `node-version`, `devdeps-*` | Verifies Node >= 22 and confirms `tsc` binary exists on disk. |
| **Phase 1** | `no-raw-colours` | Scans for non-token color literals in web components. |
| **Phase 1** | `dollar-sweep` | Prevents hardcoded API currency literals in consumer UI. |
| **Phase 1** | `forbidden-file-diff` | Validates `git diff main...HEAD` against unowned shared infrastructure. |
| **Phase 2** | `tsc-forge-control` | High-speed TypeScript compilation check for backend API. |
| **Phase 2** | `tsc-forge-control-web` | High-speed TypeScript compilation check for web client. |
| **Phase 2** | `instrument-typecheck` | Typechecks `scripts/checks/` test harness (deferred to `--full`). |
| **Phase 3** | `web-build` | Next.js production build (`pnpm build`) verifying client boundaries. |
| **Phase 4** | `gates-808-suite` | Complete functional regression gate suite (`gates-808.sh`). |

---

## 5. Negative Control Verification Protocol

A verification check that passes regardless of code correctness is a defective assertion. Every check and test added to the OS must be proven to **discriminate**.

### The Discrimination Protocol
For any new check or validator:
1. **Inject Defect (Red Probe)**: Introduce a deliberate syntactic, semantic, or token defect into a scratch file.
2. **Verify Failure**: Execute the check and assert that it returns exit code `1` (FAIL) and identifies the exact file and line number in its diagnostic output.
3. **Clean Up**: Remove the scratch defect.
4. **Verify Recovery (Green Probe)**: Execute the check again and assert that it returns exit code `0` (PASS).

The automated suite `scripts/checks/test-guard-discrimination.sh` — run directly with `bash scripts/checks/test-guard-discrimination.sh`; there is **no** `aios guard test-discrimination` subcommand, the CLI's `guard` action only recognizes `fast`/`full`/`strict` and silently falls back to `--fast` for anything else — validates that `guard.sh` discriminates against:
- TypeScript type errors (`_guard-scratch-typeerror.ts`)
- Raw hex color literals (`_guard-scratch-colour.tsx`)
- Dollar-denominated price strings (`_guard-scratch-dollar.tsx`)

---

## 6. Screenshot Harness Protocol

Visual changes must be validated against real rendered screenshots. The AI OS uses `/opt/ai-os/workspace/shots-aios.mjs` to capture ground-truth screenshots across all surfaces.

### Critical Traps & Rules:
1. **Session Cookie Salt**:
   The live NextAuth session uses `__Secure-authjs.session-token`. Pass the cookie from `/tmp/aios-cookie.txt`.
2. **Tall Viewport vs. FullPage**:
   Next.js 15 flex layouts break under Playwright's `fullPage: true`. The harness configures a tall fixed viewport (`1680x2200`).
3. **Wait Until Commit**:
   Next.js App Router streaming requires `waitUntil: "commit"` rather than `domcontentloaded` (which never resolves on active SSE connections).
4. **Surface Selection via LocalStorage**:
   The desktop app switches surfaces via `localStorage.getItem("forge.desktop.surface")`. Values **must** be formatted with `JSON.stringify(surface)` (e.g. `""tasks""`), otherwise `usePersistentState` falls back to default.
5. **Output Destination**:
   Screenshots must be saved to `/opt/ai-os/uploads/$FORGE_RUN_ID/<stamp>-<label>.png` (never `/tmp`).

### Taking Screenshots
```bash
export FORGE_SESSION_COOKIE="$(cat /tmp/aios-cookie.txt 2>/dev/null || echo '')"
SHOT_SURFACES=terminal,tasks SHOT_STAMP=$(date -u +%Y%m%d%T) SHOT_OUT=/opt/ai-os/uploads/$FORGE_RUN_ID   node /opt/ai-os/workspace/shots-aios.mjs
```

Or using the unified CLI:
```bash
aios screenshots take --url "http://127.0.0.1:7701/desktop" --label "terminal-surface"
```

---

## 7. Unified `aios` CLI Reference

The `aios` CLI (`forge-control/bin/aios.mjs`) provides a comprehensive command-line suite for developers and agents.

### Global Flags
- `--json`: Output raw, machine-readable JSON for piping to scripts or subagents.
- `--no-color`: Disable ANSI formatting.
- `--help`, `-h`: Display context-sensitive command documentation.

### Subcommands & Syntax

#### 1. `aios projects`
Manage autonomous multi-agent coding projects:
- `aios projects list` — List all active and completed projects with status, phase, and spend.
- `aios projects show <id>` — Display detailed project metadata, current task graph, and error state.
- `aios projects create <name> [--brief "text"] [--tier fast|standard|flagship] [--repo path]` — Launch a new project.
- `aios projects pause <id>` — Pause an active project execution loop.
- `aios projects resume <id>` — Resume a paused project.
- `aios projects unwedge <id>` — Unwedge a project stuck in transient lock states.

#### 2. `aios runs`
Inspect agent runs and exchange coordination messages:
- `aios runs list [--project <id>] [--status running|done|failed] [--limit 20]` — List execution runs.
- `aios runs show <id>` — Inspect run details, tool call logs, and exit status.
- `aios runs message <id> "<message>" [--from worker|operator|manager]` — Dispatch a message into a run.
- `aios runs stop <id>` — Gracefully request run termination.

#### 3. `aios tasks`
Manage discrete work items within project task graphs:
- `aios tasks list [--project <id>] [--status pending|running|done|failed] [--limit 20]` — List project tasks.
- `aios tasks show <id>` — Inspect task specification, logs, and failure details.
- `aios tasks create <name> [--project <id>] [--role builder|reviewer|architect] [--brief "text"]` — Create a new task.
- `aios tasks retry <id>` — Re-queue a failed task for execution.
- `aios tasks cancel <id>` — Cancel a pending or running task.

#### 4. `aios vault`
Interact with Konrad's Obsidian knowledge vault:
- `aios vault search "<query>" [--limit 10]` — Perform hybrid semantic/keyword search over Obsidian notes.
- `aios vault today` — Fetch and display today's daily log note.
- `aios vault read <relative-path>` — Read note markdown content.
- `aios vault append <note-name> "<content>"` — Append structured content to a daily or topic note.

#### 5. `aios pipeline`
Monitor Content Forge video generation queues:
- `aios pipeline status` — View BullMQ queue metrics (waiting, active, completed, failed).
- `aios pipeline topics` — List backlog topics and video generation candidates.

#### 6. `aios spend`
Audit model usage and LLM costs:
- `aios spend summary [--days 30]` — View total tokens, requests, and cost breakdown.
- `aios spend breakdown [--days 30]` — View per-model (Opus, Sonnet, Flash, Haiku) spend tables.

#### 7. `aios screenshots`
Audit and manage visual test artifacts:
- `aios screenshots list [--run <id>] [--limit 10]` — List captured UI screenshots.
- `aios screenshots take [--url <url>] [--label <label>] [--out <dir>]` — Capture viewport screenshot.
- `aios screenshots view <filename>` — Inspect metadata and upload URI of a screenshot.

#### 8. `aios terminal`
Interact with persistent tmux shell sessions on the VPS:
- `aios terminal list` — List active shell sessions and process status.
- `aios terminal create [--title "shell"] [--cwd "/opt/forge-ai-os"]` — Spawn a new persistent shell.
- `aios terminal run <id> "<command>"` — Execute a command inside an active shell session.

#### 9. `aios guard`
Pre-merge verification and discrimination tests:
- `aios guard fast` — Run static rules, token purity, and typechecking (< 30s).
- `aios guard full` — Run complete suite including web build and functional checks.
- `aios guard strict` — Run full suite, failing on any skipped check.
- `bash scripts/checks/test-guard-discrimination.sh` — Run negative control proof across all defect classes. No `aios guard` action wraps this yet; passing an unrecognized action (e.g. `aios guard test-discrimination`) silently falls back to `--fast` instead of erroring, so do not rely on the CLI for this one.

---

## 8. Summary Checklist for Every Developer Lane

Before submitting any work for review:
1. `cd forge-control-web && npx tsc --noEmit` exits `0`.
2. `cd forge-control && npx tsc --noEmit` exits `0`.
3. `bash scripts/checks/guard.sh --fast` reports **GUARD: GREEN**.
4. Only declared write-set files have modifications (`git status --porcelain`).
5. All commits are cleanly formatted with conventional commit messages.
