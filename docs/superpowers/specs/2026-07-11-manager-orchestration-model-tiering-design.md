# Manager orchestration + model/effort tiering

**Status:** approved, executing directly (Konrad: "write it all up now and you can directly then execute on it")
**Date:** 2026-07-11

## Motivation

Triggered by the ReelForge production run (2026-07-10): a 6-hour, 24h-directive
chat run burned Opus pricing end-to-end even though Konrad's own prompt asked
for scriptwriting on a cheaper model, because a plain Chat run has no
mechanism to delegate sub-work to a different model tier. Separately, Konrad
hand-drew the orchestration he actually wants (Manager -> Architect -> Kanban
board -> Implementer(s) -> Reviewer -> Fixer loop, sub-managers dropped as
unnecessary) and asked for both ends of model/effort selection: he picks the
Manager's own model, and the Manager/Architect picks the tier of the workers
it spawns.

## What already exists (verified against code, not assumed)

- `POST /api/projects` already creates a project and auto-seeds a round-0
  `architect` task (`routes/projects.ts:50-89`).
- The architect's own prompt already documents `curl -sX POST
  http://127.0.0.1:7700/api/projects/:id/tasks` and instructs it to fan out
  builder tasks itself, ending every round with exactly one reviewer task
  (`project-tick.ts:101-111`). **Planner has no branch in `buildPrompt()` and
  is never auto-spawned — it is a defined-but-dormant role.** Architect
  already does both the design and the task-breakdown job live today.
- The reviewer -> fix-cycle -> re-review loop already exists
  (`reconcileReviewer()`, `project-tick.ts:168-211`): a `NEEDS_FIXES` verdict
  spawns a fresh `builder` task with the reviewer's findings as its brief,
  then a re-review task, capped at `MAX_FIX_CYCLES`. This is Konrad's
  "Fixer" box — it's a builder re-invocation, not a separate agent
  definition.
- Task done/failed is inferred from the spawned run's actual process exit
  status (`reconcileSettledTasks()`, `:213-234`), not from agent self-report.
  The one place a semantic outcome IS self-reported is the reviewer's
  `VERDICT: PASS|NEEDS_FIXES` line, parsed by regex (`:173`). Today, if that
  line is missing or fix cycles are exhausted, the project silently flips to
  `blocked` with only a console warning — no notification.
- Per-role tool scoping already exists end-to-end: every `agents/*.md` has a
  `tools:` frontmatter line, read by `roleConfig()` and passed as
  `allowed_tools` when a task's run is spawned (`project-tick.ts:144-155`).
  Reviewer has no Write/Edit by design.
- Model/effort are already threaded per-role the same way (`model:`/
  `effort:` frontmatter -> `roleConfig()` -> `createRunForTask` ->
  `runClaudeCode`'s `--model`/`--effort` flags) — this is last session's
  fix, already live.
- Calendar/Gmail/Drive are already CLI-documented, not MCP
  (`cc-runner.ts:120-126`: a Python script invoked via Bash, one paragraph
  in the system prompt). Memory search has a documented REST "fast lane"
  (`GET /api/memory/search`, `:114`) *alongside* a redundant full
  `mcp__forge-memory` MCP tool that pays a schema-token cost every session
  regardless of use.
- `--add-dir ${VAULT_DIR}` (`cc-runner.ts:218`) is added to **every** spawned
  run unconditionally, before any role-specific tool check, and the global
  `SYSTEM_PROMPT` (`:98-135`) — including the "Deep lane: Grep the vault
  directly" instruction — is appended verbatim to every run regardless of
  role. A scoped builder/reviewer/scout run currently has raw filesystem
  access to the whole vault and is told about Gmail/Calendar/Reelforge tools
  it can't call, purely wasted context.

## Design

### 1. Tiering

Three named tiers, model+effort bundled (not independently selectable —
Konrad confirmed this is unnecessary complexity):

```
fast     -> claude-haiku-4-5-20251001 / medium
standard -> claude-sonnet-4-6         / high
flagship -> claude-opus-4-8           / high
```

Only `architect` and `builder` get real tiering — these are the two roles
Konrad specifically called out ("a worker can use Haiku... an architect
sometimes needs the newest model"). Planner/reviewer/scout stay on their
role-file defaults; no signal yet that they need tier variety, easy to add
later (YAGNI).

Mechanism: `project_tasks` gains a nullable `tier` column. In
`spawnTaskRuns()`, when a task has a `tier`, its model/effort come from the
`TIER_MODELS` map instead of the role file's static `model:`/`effort:`. The
role file still governs mission text and tool scoping (untiered).

- `POST /api/projects` gains an optional `architect_tier` field, threaded
  straight to the round-0 task's `tier` column. This is the one Konrad
  picks directly when kicking off a project ("the manager chooses the
  effort and model of the architect when launching it").
- `POST /api/projects/:id/tasks` gains an optional `tier` field. The
  architect's own prompt is updated to mention it in the curl example and
  given one line of guidance ("fast for straightforward tasks, flagship
  only when a task genuinely needs the strongest model") — the architect
  decides builder tiers itself when it fans out work, exactly matching
  today's live behavior of architect-creates-builder-tasks directly.
- Fix-cycle builder tasks (`reconcileReviewer`) do not inherit a tier in
  this pass — they fall back to the role default. Escalating tier on repeat
  failures is a plausible future refinement, not needed now.

Planner is explicitly left out of the automated chain in this pass — it
stays defined but dormant, exactly as it is today. Wiring it in as a real
sequential stage is a separate, larger change (new prompt branch, changing
architect's own instructions to hand off instead of going direct) that
wasn't asked for and isn't needed to deliver the tiering behavior.

### 2. No new MCP server for project control

Project/task creation is already curl-documented to the architect
(`project-tick.ts:106`) — that pattern is correct and stays. The Manager
(plain Chat run) gets the same treatment: the existing "forge-control API"
line in the global system prompt (`cc-runner.ts:103`) is extended to
mention `POST /api/projects` explicitly, instead of building a new
`mcp__forge-project` MCP server (which would pay a schema-token cost every
chat session regardless of whether a project ever gets created). Same
reasoning as the existing Calendar/Gmail-as-CLI and memory-fast-lane
precedent already in this codebase.

### 3. Manager's own model/effort selector

New dropdown next to Send in `ChatSurface.tsx`: Haiku 4.5 / Opus 4.8
(default) / Sonnet 5 / Sonnet 4.6 (cheap). Model already has
`POST /:id/model` (`chat.ts:205-218`, `db/runs.ts:332-347`); effort gets the
identical treatment — new `setRunEffort()` in `db/runs.ts` and
`POST /:id/effort` route, same shape as the model endpoint. Effort choices
in the UI capped at `high` (no `xhigh`/`max`), per Konrad's explicit
instruction.

### 4. Knowledge scoping (vault access made conditional)

`runClaudeCode()` gains an `opts.vaultAccess?: boolean` flag (default
`true`, preserving today's behavior for plain Chat/Manager runs). The
`SYSTEM_PROMPT` const becomes a small function that only includes the
"Knowledge — search BEFORE you answer" block (fast lane + deep lane +
profile pointer) when `vaultAccess` is true, and `--add-dir VAULT_DIR` is
only pushed when `vaultAccess` is true. `createRunForTask`/`spawnTaskRuns`
default `vaultAccess` to `false` for the four non-architect Kanban roles
(planner/scout/builder/reviewer) and `true` for architect, matching "not
every agent needs my whole knowledge base — it's a game of specializations."

This is scoped narrowly on purpose: it fixes the vault-specific leak (raw
filesystem grep + the instruction encouraging it) without attempting a full
per-role decomposition of the rest of the system prompt (Gmail/Calendar/MCP
server list/subagent roster). That's a real follow-on improvement but a
separate, larger change with more blast radius (touches every run, including
Telegram-specific formatting rules in the same string) — flagged here as
explicitly out of scope for this pass, not silently dropped.

### 5. Reliability: notify on silent-blocked projects

In `reconcileReviewer()`, both failure branches that currently only
`console.warn` (no parseable VERDICT line; `MAX_FIX_CYCLES` exhausted) also
call `queueNotification()` — same pattern already used for guardrail-trip
notifications this session, reusing existing infra, no new mechanism.

## Explicitly out of scope for this pass

- A live, persistent "manager loop" that watches the Kanban board and issues
  its own Task-tool calls (the earlier "Approach B"). The reactive ticker
  plus the tiering above already delivers what was asked for without a new
  always-on process.
- Wiring Planner into the automated chain.
- Sub-manager agents — confirmed unnecessary, never built, nothing to
  remove.
- Full per-role decomposition of the global system prompt beyond the vault
  block.
- Independent (non-tied) model/effort selection for spawned workers.
