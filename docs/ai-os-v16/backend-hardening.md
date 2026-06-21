# AI OS v1.6 — Backend Hardening Audit

_Audit only. No code changed. Date: 2026-06-21._

## TL;DR

The "claude timed out after 180000ms" failure was a **hard timeout on a long
single-shot generation** with **no streaming, no retry, no resume**, and a
guardrail layer that the chat path never consults. The run ended in `failed`
state, the original onboarding prompt was preserved in `thread` but only a
freshly-posted user message can re-enter the executor (no "retry" path).
Heartbeats are written but nothing converts a stale `running` row into `stuck`,
so the manager loop's "unstick playbook" cannot fire. Worker-orchestrator /
worker-render still ignore `fleet_state` entirely.

## Where 180000ms lives

- **`forge-control/src/executor.ts:27`**
  `const RUN_TIMEOUT_MS = Number(process.env.RUN_TIMEOUT_MS ?? "180000");`
- Used at `executor.ts:109` for AbortController and at `executor.ts:117` as
  `timeout_ms` in the JSON body to `POST {POOL_URL}/v1/run`.
- **Not overridden** in `forge-control/ecosystem.config.cjs` (no `RUN_TIMEOUT_MS`
  in the env block) → production runs at the 180000ms default.
- Pool URL hardcoded to `http://127.0.0.1:8092`. Onboarding prompts ("read the
  whole obsidian vault…") routinely exceed 180s end-to-end at Claude Opus
  throughput, especially with cold cache.

## Run state-machine gaps

| Gap                                     | Evidence                                                                                                                                                                          | Impact                                                                                                                                            |
| --------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------- |
| `failed` → no retry path                | `executor.ts:184-200` writes a `system/kind:error` turn and `status='failed'`; chat.ts only re-queues on a **new** user message (`chat.ts:71-93`)                                 | Konrad's onboarding prompt is dead; he must paste the same prompt again to retry                                                                  |
| `stuck` is never written                | `heartbeat()` only updates `last_heartbeat_at` (`executor.ts:155-162`); no watchdog flips stale `running` → `stuck`; `stuck_signal` always NULL                                   | Manager loop (line 416) only mirrors HCP messages; v1.6 backlog #1 "unstick playbook" has no detector                                             |
| Thread persisted only on completion     | `appendAndComplete` (`executor.ts:138-153`) runs once, post-`callClaudePool`                                                                                                      | A 179s generation that crashes mid-flight loses every token; no incremental streaming into `runs.thread`                                          |
| Status PATCH allows any transition      | `chat.ts:96-106` accepts any valid status; `failed → queued` works in SQL but no UI surfaces it and executor doesn't rebuild a "retry this turn" context                          | Sharp edge: could re-queue a `running` row and double-execute                                                                                     |
| No per-run timeout / budget enforcement | `callClaudePool` uses one global `RUN_TIMEOUT_MS` for every prompt size                                                                                                           | Long onboarding ≡ smoke test ≡ chat message; all share the same 180s ceiling                                                                      |
| Fleet freeze coverage incomplete        | `executor.ts:211-220` + HCP dispatcher honor `fleet_state`; **`apps/worker-orchestrator` and `apps/worker-render` have zero references to `fleet_state`** (grep confirmed)        | "Pause all" leaks: BullMQ workers keep draining their queues during a freeze                                                                      |
| Guardrails ungated on chat              | `evaluateGuardrails()` (`forge-control/src/db/autonomy.ts:232`) is callable but **executor never calls it**; `spend.per_run_cap` / `runtime.pause_all` only bite if a caller asks | A 180s Opus burn never trips `spend.per_run_cap`; `runtime.pause_all` is enforced only because executor independently checks `fleet_state.status` |
| `connector_configs` unused for retries  | Table defined in `migrations/0021_ai_os_tables.sql:164` with `config jsonb`; no rows referenced from executor, no `claude-pool`/`AI33`/`forge-api` config read at runtime         | Backoff / max_retries / per-connector timeout are unconfigurable; nothing surfaces "claude-pool last_error" to the user                           |

## Top 5 backend hardening tasks

| #   | Problem (1 line)                                                    | Fix (1 line)                                                                                                                                                                                                        | File                                                               | Effort                                                                |
| --- | ------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------ | --------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------- | --- |
| 1   | 180s hard timeout kills long prompts with no retry/resume           | Add per-run `timeout_ms` + `max_retries` from `metadata` or `connector_configs.claude-pool.config`; on timeout, retry once with extended budget, then mark `stuck` not `failed`                                     | `forge-control/src/executor.ts` (callClaudePool + processRun)      | M                                                                     |
| 2   | No stuck detector → manager loop can't unstick                      | Add a periodic SQL sweep in `managerLoop()` flipping `running` rows with `last_heartbeat_at < now() - interval '90s'` to `stuck` and setting `stuck_signal`                                                         | `forge-control/src/executor.ts` (managerTick)                      | S                                                                     |
| 3   | Chat runs bypass guardrails (no spend cap, no kill-switch via rule) | Call `evaluateGuardrails({agent:'forge-executor', action:'claude-pool.run', category:'financial', payload:{estimated_spend_eur, thread_chars}})` before `callClaudePool`; trip → `failed` with `blocked_by` in meta | `forge-control/src/executor.ts:164` + import from `db/autonomy.ts` | S                                                                     |
| 4   | Worker-orchestrator / worker-render ignore `fleet_state`            | Add a shared `isFleetPaused()` helper (e.g. `packages/db/src/fleet.ts`) and gate BullMQ `worker.run()` / processor entry on it; verify pause covers all draining workers                                            | `apps/worker-orchestrator/src/*`, `apps/worker-render/src/*`       | M                                                                     |
| 5   | Thread only persisted post-completion → mid-run crash = total loss  | Switch pool client to streaming (SSE/chunked) and `UPDATE runs SET thread = thread                                                                                                                                  |                                                                    | $delta` every N tokens; on crash, partial assistant turn is preserved | `forge-control/src/executor.ts` (callClaudePool + appendMessage delta path); pool-side streaming endpoint | L   |

## Risks

- **Retry storms**: task #1 must cap retries (≤1) and respect `runtime.pause_all`
  before re-enqueuing — otherwise a flaky claude-pool produces infinite loops.
- **Stuck detector false positives**: heartbeat interval is 5s; a 90s threshold
  is safe today but coupling it to `RUN_TIMEOUT_MS + grace` is more robust.
- **Guardrail spend estimation**: `evaluateGuardrails` expects `spend_eur` —
  we'd need a cheap upstream estimate (chars × per-1k rate); under-estimating
  defeats the cap.
- **Fleet pause for BullMQ**: pausing mid-job is dangerous (half-rendered MP4s);
  freeze should drain to a clean state before idling — not yank workers.
- **Streaming persistence cost**: per-token UPDATEs on `runs.thread` will
  hammer Postgres; batch every 500ms or 200 tokens.
