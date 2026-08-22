# HANDOFF: Autonomy & Automation Architecture

## 1. Product Decision: The Purpose of Automation

### The Finding
Konrad opened the Automation page and observed:
> *"The automation stuff is probably other apps that I connect with this thing, or what is it?"*

### The Decision
We maintain **Automation** as the home for **Autonomous Routines & Inbound Event Triggers** (Scheduled Tasks / Cron + Webhooks), with the following architectural clarity:
1. **Default Tab = Scheduled Routines (`cron`):** Konrad's daily executive routines live here (e.g. `mentor-morning` check-in at 07:00, `mentor-evening` debrief at 21:30, system watchdogs). These are self-executing autonomous loops.
2. **Inbound Webhooks (`webhooks`):** Triggers from external services (GitHub PRs, Stripe events, generic JSON) mapped to agent prompts.
3. **Contextual Cross-Link Banner:** A permanent header banner directs users looking for external account credentials and OAuth tokens to `Settings → Connections` (`/desktop?surface=settings&tab=connections`).

### Why NOT Retire or Move to Settings
- **Scheduled Routines are active runtime automations**, not static credentials or connection settings. Putting daily cron schedules inside "Settings → Connections" would obscure the live operating heartbeat of the AI OS.
- Inbound webhooks are event receivers with prompt templates and execution history, closely tied to cron routines.
- Connecting external apps (OAuth, API keys) remains strictly in `Settings → Connections`, while executing scheduled/event-driven agent tasks is explicitly **Automation**.

---

## 2. The Two Core Bug Fixes

### Bug 1: Model-Aware Spend Estimation (`executor.ts:575` + `db/autonomy.ts`)
- **Root Cause:** `executor.ts` calculated `(threadChars / 1000) * 0.04` for all runs, treating Gemini workers as if they incurred per-token Claude billing. Because Gemini runs on a flat Google AI Pro subscription (`isGeminiModel(model) === true`), direct token cost is €0.00. This caused Gemini workers to falsely trip the €50-€200 EUR caps and abort, forcing Konrad to disable financial guardrails entirely.
- **Fix:**
  - Check `isGeminiModel(run.metadata?.model)`.
  - For Gemini: `spend_eur = 0`. Evaluate token caps (`tokens_per_run_cap: 1,000,000`) instead of EUR spend.
  - For Claude: Evaluate character-based estimated EUR spend against `spend.per_run_cap` and `spend.daily_cap`.
  - Financial guardrails can now safely be re-enabled without blocking Gemini workers.

### Bug 2: Emergency Pause & Fleet Freeze Desynchronization
- **Root Cause:** `fleet_state` in PostgreSQL and `runtime.pause_all` in `guardrail_rules` operated as disconnected boolean flags. Toggling one did not update the other.
- **Fix:**
  - `setFleetState(status)` in `db/ai_os.ts` atomically updates `guardrail_rules` where `id = 'runtime.pause_all'` (`enabled = (status === 'paused')`).
  - `updateRule('runtime.pause_all')` in `db/autonomy.ts` atomically updates `fleet_state` (`status = enabled ? 'paused' : 'running'`).
  - `evaluateGuardrails` checks `fleet_state` status and synchronized rule state.

---

## 3. Automation Surface & API Improvements
1. **Raw Webhook Secret Return:** `createWebhook` in `db/webhooks.ts` / `routes/webhooks.ts` returns the unmasked `secret` in the create response so the UI can copy it immediately without rotating.
2. **Cron Immediate Execution (`[Run Now]`):** Added `POST /api/cron/:id/run` and `fireScheduleById` to trigger a routine on demand.
3. **Local Time & Humanized Schedules:** Displays schedules in Berlin local time (`Europe/Berlin`) with humanized labels (*"Daily at 21:30 Berlin Time"*).
4. **Direct Run Linkage:** `last_run_id` links directly to `/desktop?surface=chat&chat=<id>`.
