# AI OS Development & Engineering Guide

This document is the authoritative engineering guide for developers and autonomous agents working on Konrad's Personal AI OS (`forge-ai-os`). It defines the environment constraints, worktree workflows, file ownership rules, verification gates, screenshot protocols, and the unified `aios` CLI toolchain.

---

## 0. Invoking `aios` — read this before running any example below

**`aios` is not on `PATH` by default.** It is a `bin` entry in `forge-control/package.json`, which only becomes a command after a package manager links it. Until then, `aios projects list` is `command not found`. Every command block in this document is written in the always-true form:

```bash
# From the repository (or worktree) root — works everywhere, no install:
node forge-control/bin/aios.mjs projects list
```

The CLI resolves its own paths from `import.meta.url`, not from `$PWD`, so the absolute form works from any directory:

```bash
node /opt/forge-ai-os/forge-control/bin/aios.mjs projects list
```

### One-time install for an interactive shell (Konrad, or a human on this box)

This makes bare `aios` work everywhere. It points at the **live checkout**, which is what you want for daily use:

```bash
ln -sf /opt/forge-ai-os/forge-control/bin/aios.mjs /usr/local/bin/aios
command -v aios && aios terminal list       # verify: prints the path, then the session table
```

> **Availability check first.** `forge-control/bin/aios.mjs` reaches the live checkout only when this branch merges. As of 2026-08-23 19:00 UTC it is **not** there yet (`ls /opt/forge-ai-os/forge-control/bin/aios.mjs` → No such file). Run that `ls` before the `ln -sf`; until it succeeds, point the symlink at a checkout that does have the file, or use the `node …` form. The mechanism itself is verified — a symlink to this worktree's copy on `$PATH` resolves and runs (`import.meta.url` survives the symlink, so the CLI still finds its own `node_modules`).

**Agents in a worktree must not run that.** `/usr/local/bin/aios` is shared; pointing it at a worktree hijacks Konrad's `aios` and it breaks the moment the worktree is torn down. From a worktree, always use `node forge-control/bin/aios.mjs`.

Prerequisite either way: `forge-control/node_modules/.bin/tsx` must exist (see §2 — `pnpm install --frozen-lockfile --prod=false`). The launcher checks for it and tells you exactly that if it is missing.

In prose and in the reference tables of §7 the commands are written as `aios <subcommand>` for readability. Prefix them with `node forge-control/bin/aios.mjs` if you have not installed the symlink.

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
node forge-control/bin/aios.mjs guard fast

# Full pre-merge guard (Phases 0-4: Includes web production build and full gates-808 suite):
bash scripts/checks/guard.sh --full
# Or via CLI:
node forge-control/bin/aios.mjs guard full

# Strict mode (Fails on any skipped check):
bash scripts/checks/guard.sh --full --strict
node forge-control/bin/aios.mjs guard strict

# Machine-readable JSON report:
bash scripts/checks/guard.sh --fast --json
```

### What the guard actually costs on this box
Measured 2026-08-23 on the live VPS with ~10 agent lanes running — load average 17-27 on 16 cores for the rows marked measured here, 32-47 for the round-1 reviewer's cold run:

| Run | Measured | PLAN.md target |
|---|---|---|
| `guard.sh --full` (11 checks, incl. web build + gates-808) | **3m55s - 6m00s** (3 runs) | — |
| `check-instrument-typecheck.sh`, warm cache | **19.4s** | <15s cold |
| `check-instrument-typecheck.sh`, immediately re-run | **15.5s** | <2s hot |
| `check-instrument-typecheck.sh`, cold cache | ~91s (round-1 reviewer's measurement, load 32-47) | <15s |

The targets in `PLAN.md` §1.1 were set for an idle machine and are **not met under contention** — process-start latency, not compile work, dominates when the box is loaded (see the `typecheck-fork-storm-under-contention` memory note). Budget the measured numbers, not the targets, and re-measure with `uptime` in hand before calling a regression.

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
The stamp must be compact UTC ISO-8601 with **no colons** — `date -u +%Y%m%d%T` produces `2026082316:53:40`, which breaks the convention and makes the filename awkward to quote. Use `%H%M%S` explicitly:

```bash
export FORGE_SESSION_COOKIE="$(cat /tmp/aios-cookie.txt 2>/dev/null || echo '')"
SHOT_SURFACES=terminal,tasks \
SHOT_STAMP=$(date -u +%Y%m%dT%H%M%SZ) \
SHOT_OUT=/opt/ai-os/uploads/$FORGE_RUN_ID \
  node /opt/ai-os/workspace/shots-aios.mjs
```
`date -u +%Y%m%dT%H%M%SZ` → `20260823T171055Z`.

Or using the unified CLI — the surface is a **positional argument**, not `--url`:
```bash
node forge-control/bin/aios.mjs screenshots take terminal --out /opt/ai-os/uploads/$FORGE_RUN_ID
```

---

## 7. Unified `aios` CLI Reference

The `aios` CLI (`forge-control/bin/aios.mjs`) provides a comprehensive command-line suite for developers and agents. **Every syntax line below was taken from the CLI's own `--help` output** — run `node forge-control/bin/aios.mjs <subcommand> --help` if you suspect this table has drifted; the help text is the source of truth, this is a copy.

Remember §0: bare `aios` only works after the symlink install. Otherwise prefix each line with `node forge-control/bin/aios.mjs`.

### Global Flags
- `--json`: Output raw, machine-readable JSON for piping to scripts or subagents.
- `--no-color`: Disable ANSI formatting (also honoured via `NO_COLOR`).
- `--help`, `-h`: Display context-sensitive command documentation.
- `FORGE_CONTROL_URL`: Override the API base (default `http://127.0.0.1:7700`).

### Subcommands & Syntax

#### 1. `aios projects`
Manage autonomous multi-agent coding projects:
- `aios projects list`
- `aios projects show <id>`
- `aios projects create <title> --brief <text|file> [--tier fast|junior|standard|flagship|gemini] [--repo ai-os|content-forge|scratch] [--base-branch <name>] [--mode goal|standard]`
- `aios projects pause <id>` / `aios projects resume <id>`
- `aios projects unwedge <id> [--force]` — retry the tasks a stuck project is blocked on.

#### 2. `aios runs`
Inspect agent runs and exchange coordination messages:
- `aios runs list [--project <id>] [--limit <n>]` — there is no `--status` filter.
- `aios runs show <id>` — run header plus the last 10 comms entries (sender, direction, body).
- `aios runs message <id> <text> [--from worker|konrad|manager]` — sends with your own `$FORGE_RUN_UUID` as `sender_run_id`.
- `aios runs stop <id>` — graceful stop.

#### 3. `aios tasks`
Manage discrete work items within project task graphs:
- `aios tasks list [--project <id>]`
- `aios tasks show <id>`
- `aios tasks create --project <id> --role <role> --title <title> --brief <text|file> [--tier <tier>] [--depends <id,id>] [--workstream <name>] [--write-set <path,path>]`
- `aios tasks retry <id> [--force]` — `--force` overrides the retry cap.
- `aios tasks cancel <id>`

#### 4. `aios vault`
Interact with Konrad's Obsidian knowledge vault:
- `aios vault search <query>`
- `aios vault today`
- `aios vault read <path>`
- `aios vault append <path|section> <text>` — append only; the vault is never truncated.

#### 5. `aios pipeline`
Monitor Content Forge video generation queues:
- `aios pipeline status` — BullMQ queue metrics.
- `aios pipeline topics list`
- `aios pipeline topics add <brief>` — **refuses by design.** forge-control has no write endpoint for `content_jobs`; topics are created through the `reelforge` MCP tool (`add_topics`) or the `rf` CLI. The command errors instead of faking a queued confirmation.

#### 6. `aios spend`
Audit model usage and LLM costs:
- `aios spend summary` — the three fixed windows (today / 7-day / 30-day) plus the provider×kind breakdown. Metered spend and claude-code's notional subscription cost are separate columns; the €50/day cap only ever counts the metered one. There is no `--days` flag.
- `aios spend breakdown [--since 24h]` — today's raw rollup.

#### 7. `aios screenshots`
Audit and manage visual test artifacts:
- `aios screenshots list [--run <id>]`
- `aios screenshots take <surface> [--out <dir>] [--stamp <label>]` — surface is positional; it drives `shots-aios.mjs` with `SHOT_SURFACES`.
- `aios screenshots view <path>` — size and mtime of a captured file.

#### 8. `aios terminal`
Interact with persistent tmux shell sessions on the VPS:
- `aios terminal list`
- `aios terminal create [--title <t>] [--cwd <path>]`
- `aios terminal run <command> --session <id>` — **`--session` is mandatory.** These are live interactive shells and the desktop Terminal pane drives the same pool; without an explicit target the CLI refuses rather than typing into whatever shell Konrad has open.
- `aios terminal run <command> --new [--title <t>] [--cwd <p>]` — create a session of your own and run there.

#### 9. `aios guard`
Pre-merge verification:
- `aios guard fast` — static rules, token purity, cached parallel typecheck.
- `aios guard full` — plus the web production build and the functional suite.
- `aios guard strict` — full suite, failing on any skipped check.
- `bash scripts/checks/test-guard-discrimination.sh` — the negative-control proof. No `aios guard` action wraps this; an unrecognised action (e.g. `aios guard test-discrimination`) silently falls back to `--fast`, so invoke the script directly.

See §4 for measured runtimes — the `<30s` in the CLI's own help text for `fast` holds on an idle box, not on a loaded one.

---


## 8. Summary Checklist for Every Developer Lane

Before submitting any work for review:
1. `cd forge-control-web && npx tsc --noEmit` exits `0`.
2. `cd forge-control && npx tsc --noEmit` exits `0`.
3. `bash scripts/checks/guard.sh --fast` reports **GUARD: GREEN**.
4. Only declared write-set files have modifications (`git status --porcelain`).
5. All commits are cleanly formatted with conventional commit messages.
