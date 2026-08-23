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

---

## 6. Round 5 correction — "Direct Run Linkage" did not link (fix cycle 1)

§3 item 4 above claimed `last_run_id` "links directly to `/desktop?surface=chat&chat=<id>`".
It did not, and could not: **this console is one route.** Which surface you see is React
state persisted to `localStorage` under `forge.desktop.surface`; nothing in the app reads
`location.search` (`useSearchParams` appears nowhere outside `signin`). An anchor to
`/desktop?surface=…` therefore triggers a full reload that drops the query string and
restores whatever surface you were already on. All five such links across the two
surfaces were inert. Round 4's reviewer found it; round 5 fixed it.

**The mechanism now used** — `forge-control-web/app/desktop/deep-link.ts` — is the one the
app already uses to survive F5: write the destination into the target surface's own
storage key, then flip the surface through the `onNav` callback the shell hands down.
`openChatRun` writes `forge.chat.selected` and clears `forge.chat.navStack` (a stack left
standing from another chat would assert that its worker belongs to the run being opened);
`ChatSurface` mounts on arrival and honours it, because its "open the newest chat"
effect is guarded by `if (!selId …)`.

**Open item for whoever owns `DesktopApp.tsx` / `SettingsSurface.tsx`** — not taken here
because this project does not own those files:

1. **`?surface=` is still not a thing.** If Konrad ever wants to bookmark or share a link
   into a surface, `DesktopApp` needs to read `?surface=` / `?chat=` on mount and seed the
   two storage keys from it. `deep-link.ts` is where that logic should live so the two
   paths cannot diverge.
2. **`Settings → Connections` lands on the settings index, not on CONNECTIONS.**
   `SettingsSurface.tsx:142` holds its open section in a plain `useState` with no storage
   key, so there is nothing to pre-write. Giving that `useState` a `usePersistentState`
   key (e.g. `forge.settings.section`) is a two-line change in a file another lane is in;
   `deep-link.ts`'s `openSettings` is the one place that would then take the section name.

Both are deliberate one-click-shorts, documented rather than faked. A link that pretends
to a tab this app has never had is the same class of defect as the one just removed.
